'use strict';

/**
 * 服务器指令知识库（常用指令清单）。
 *
 * 为什么单独做一层:
 *   把指令清单塞在 system prompt 里权重很低 —— 模型选择工具时主要看**工具描述**。
 *   而且清单越长越费 token。所以:
 *     1) 高频指令写进 eb_run_command 的**工具描述**里 (决策那一刻就看得见)
 *     2) 完整清单通过 eb_find_command **按关键词检索** (长尾按需取, 不占常规上下文)
 *     3) 最高频、语法特殊的操作建议直接用 tools.commandRules 做成专用工具
 *
 * 配置格式(每行一条, 用 | 分隔):
 *     指令 | 说明 | 关键词(逗号分隔, 可选) | 需要等级(可选)
 *
 *   例:
 *     easywhitelist add {player}|把玩家加入白名单|白名单,加白,whitelist|3
 *     list|查看在线玩家|在线,人数,几个人|
 *     time set day|把时间设为白天|白天,时间|
 *
 * 也兼容旧的 tools.commandHints: 没有 | 的行会当成"只有说明"的条目。
 */

const util = require('./util.js');
const config = require('./config.js');

/** 解析成 [{command, desc, keywords:[], level}] */
function parse() {
    const book = util.trim(config.get().tools.commandBook);
    const hints = util.trim(config.get().tools.commandHints);
    const out = [];

    function addLine(line) {
        const t = util.trim(line);
        if (!t || t[0] === '#') return;
        if (t.indexOf('|') < 0) {
            // 兼容 commandHints 的自由文本
            out.push({ command: t, desc: '', keywords: [], level: null });
            return;
        }
        const p = t.split('|').map(function (x) { return util.trim(x); });
        if (!p[0]) return;
        out.push({
            command: p[0],
            desc: p[1] || '',
            keywords: config.toList(p[2] || '').map(function (x) { return String(x).toLowerCase(); }),
            level: (p[3] === undefined || p[3] === '') ? null : Number(p[3])
        });
    }

    if (book) book.split(/\r?\n/).forEach(addLine);
    if (hints) hints.split(/\r?\n/).forEach(addLine);
    return out;
}

/**
 * 带校验的解析: 顺便报出格式错误和重复条目, 方便 WebUI 提示管理员。
 * @returns {{entries:Array, errors:Array<{line:number, text:string, reason:string}>}}
 */
function parseChecked() {
    const raw = ((config.get().tools && config.get().tools.commandBook) || '') +
        (util.trim((config.get().tools && config.get().tools.commandHints) || '')
            ? ('\n' + config.get().tools.commandHints) : '');
    const errors = [];
    const seen = {};
    const entries = [];

    raw.split(/\r?\n/).forEach(function (line, idx) {
        const t = util.trim(line);
        if (!t) return;
        if (t[0] === '#') return;
        if (t.indexOf('|') < 0) {   // 兼容 commandHints 自由文本
            entries.push({ command: t, desc: '', keywords: [], level: null, line: idx + 1 });
            return;
        }
        const p = t.split('|').map(function (x) { return util.trim(x); });
        if (!p[0]) {
            errors.push({ line: idx + 1, text: t, reason: '缺少指令' });
            return;
        }
        const lv = (p[3] === undefined || p[3] === '') ? null : Number(p[3]);
        if (lv !== null && (isNaN(lv) || lv < 0 || lv > 3)) {
            errors.push({ line: idx + 1, text: t, reason: '等级必须是 0~3 或留空' });
        }
        if (seen[p[0]] !== undefined) {
            errors.push({ line: idx + 1, text: t, reason: '与第 ' + seen[p[0]] + ' 行重复' });
        } else {
            seen[p[0]] = idx + 1;
        }
        entries.push({
            command: p[0], desc: p[1] || '',
            keywords: config.toList(p[2] || '').map(function (x) { return String(x).toLowerCase(); }),
            level: (lv === null || isNaN(lv)) ? lv : lv,
            line: idx + 1
        });
    });
    return { entries: entries, errors: errors };
}

/** 供 eb_run_command 的工具描述使用: 只列前 N 条高频指令 */
function forToolDescription(limit) {
    const list = parse();
    if (!list.length) return '';
    const max = Math.max(1, Number(limit) || Number(config.get().tools.commandBookInDescription) || 8);
    const shown = list.slice(0, max);
    const lines = shown.map(function (e) {
        return '- ' + e.command + (e.desc ? '  (' + e.desc + ')' : '');
    });
    let text = '\n本服常用指令(优先用这些写法, 本服指令可能与原版不同):\n' + lines.join('\n');
    if (list.length > shown.length) {
        text += '\n(还有 ' + (list.length - shown.length) + ' 条, 需要时用 eb_find_command 查询)';
    }
    return text;
}

/** 供 system prompt 使用 */
function forPrompt(limit) {
    const list = parse();
    if (!list.length) return '';
    const max = Math.max(1, Number(limit) || 20);
    const lines = list.slice(0, max).map(function (e) {
        return e.command + (e.desc ? '(' + e.desc + ')' : '');
    });
    return '本服指令知识库: ' + lines.join('; ');
}

/**
 * 按关键词检索。
 * @returns {Array} 命中的条目(最多 limit 条)
 */
function search(query, limit) {
    const q = util.trim(String(query || '')).toLowerCase();
    const list = parse();
    const max = Math.max(1, Number(limit) || 8);
    if (!q) return list.slice(0, max);

    const tokens = q.split(/[\s,，、]+/).filter(Boolean);
    const scored = [];
    list.forEach(function (e) {
        const hay = (e.command + ' ' + e.desc + ' ' + e.keywords.join(' ')).toLowerCase();
        let score = 0;
        if (hay.indexOf(q) >= 0) score += 10;
        tokens.forEach(function (t) {
            if (e.keywords.some(function (k) { return k.indexOf(t) >= 0 || t.indexOf(k) >= 0; })) score += 6;
            if (e.desc.toLowerCase().indexOf(t) >= 0) score += 4;
            if (e.command.toLowerCase().indexOf(t) >= 0) score += 2;
        });
        if (score > 0) scored.push({ score: score, entry: e });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, max).map(function (x) { return x.entry; });
}

/**
 * 把指令模板转成正则: <玩家> / {player} 之类占位符可匹配任意一个参数。
 * 用于判断"这条指令命中了知识库里的哪一条", 从而用知识库里写的等级来判定。
 */
function templateRegex(tpl) {
    const esc = String(tpl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = esc
        .replace(/\\?<[^>]+>/g, '[^\\s]+')
        .replace(/\\?\{[^}]+\}/g, '[^\\s]+');
    try {
        return new RegExp('^' + body + '(?:\\s|$)', 'i');
    } catch (e) {
        return null;
    }
}

/**
 * 这条指令命中知识库里的哪一条(取模板最长/最具体的一条)。
 * @returns {object|null}
 */
function matchEntry(command) {
    const cmd = util.trim(String(command || '')).replace(/^\//, '');
    if (!cmd) return null;
    const hits = parse().filter(function (e) {
        const re = templateRegex(e.command);
        return re && re.test(cmd);
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return b.command.length - a.command.length; });
    return hits[0];
}

/**
 * 知识库为这条指令声明的等级。
 * @returns {number|null} null = 知识库没写等级(走常规分类)
 */
function levelOf(command) {
    const hit = matchEntry(command);
    if (!hit) return null;
    return (hit.level === null || hit.level === undefined) ? null : Number(hit.level);
}

/**
 * 全部条目(紧凑形式) —— 给"查不到"时兜底。
 * 同义词判断交给模型自己做: 我们不猜"把我朋友拉进来"= 白名单,
 * 而是把本服有什么直接摊开, 让模型自己挑最接近的。
 */
function allText(limit) {
    const list = parse();
    if (!list.length) {
        return '本服指令知识库是空的(管理员还没填)。请如实告诉用户本服暂时没有配置可执行指令。';
    }
    const max = Math.max(1, Number(limit) || 80);
    const lines = list.slice(0, max).map(function (e) {
        const d = e.desc ? ('  (' + util.truncate(e.desc.split('。')[0], 28) + ')') : '';
        return '- ' + e.command + d;
    });
    let text = '本服知识库里的全部指令(' + list.length + ' 条):\n' + lines.join('\n');
    if (list.length > max) text += '\n(还有 ' + (list.length - max) + ' 条未列出)';
    return text;
}

/** 检索结果给模型看的文本 */
function searchText(query) {
    const q = util.trim(query);
    // 空查询 / * / 全部 -> 直接给全表(让模型自己浏览)
    if (!q || q === '*' || q === '全部' || q === 'all') return allText(80);

    const hits = search(q);
    if (!hits.length) {
        return '知识库里没有直接匹配 "' + q + '" 的条目。\n' +
            '你可以: ① 换一个更通用的功能词再查一次(例如 白名单 / 传送 / 给物品 / 时间 / 人数 / 封禁); ' +
            '② 从下面这份全部指令里挑最接近的。\n\n' +
            allText(80) +
            '\n\n如果这些里面确实没有用户要的功能, 就如实告诉用户本服不支持, 不要自己编指令。';
    }
    return hits.map(function (e) {
        return e.command + (e.desc ? '  —— ' + e.desc : '') +
            (e.level !== null ? ('  [需要等级 ' + e.level + ']') : '');
    }).join('\n');
}

module.exports = {
    parse: parse,
    parseChecked: parseChecked,
    allText: allText,
    matchEntry: matchEntry,
    levelOf: levelOf,
    templateRegex: templateRegex,
    search: search,
    searchText: searchText,
    forToolDescription: forToolDescription,
    forPrompt: forPrompt
};
