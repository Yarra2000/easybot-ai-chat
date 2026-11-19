'use strict';

/**
 * 自定义指令规则（自然语言 → 本服实际指令）。
 *
 * 解决什么问题:
 *   不同服务端的指令不一样。比如白名单，原版是 /whitelist，但某些服务端/模组要用
 *   /easywhitelist。光靠提示词让模型猜很容易用错，所以这里做两层保障:
 *
 *   1) **规则即工具**: 每条规则注册成一个独立工具(如 add_whitelist)，参数结构化。
 *      模型只要判断"用户想加白名单"，就会调这个工具，指令由模板渲染，
 *      完全不用它自己拼指令语法 —— 这是最可靠的一层。
 *   2) **指令改写**: 如果模型还是走了 eb_run_command 并发了 /whitelist，
 *      改写规则会在执行前把它替换成 /easywhitelist，兜住漏网。
 *
 * 配置格式（每行一条，用 | 分隔，方便在 WebUI 单行输入框里写）:
 *
 *   工具名 | 中文标题(给模型理解意图) | 指令模板 | 参数(可选) | 需要等级(可选)
 *
 *   例:
 *     add_whitelist|把玩家加入白名单|easywhitelist add {player}|player:玩家名|3
 *     del_whitelist|把玩家移出白名单|easywhitelist remove {player}|player:玩家名|3
 *
 *   指令模板里的 {参数名} 会被工具参数替换；参数列格式 `名字:说明,名字2:说明2`。
 *   也接受 JSON 数组形式:
 *     [{"name":"add_whitelist","title":"把玩家加入白名单","command":"easywhitelist add {player}",
 *       "args":[{"name":"player","desc":"玩家名"}],"level":3}]
 *
 * 改写规则格式（每行一条）: 正则 => 替换
 *   例: ^whitelist(?=\s|$) => easywhitelist
 *   (以前写的 "正则=替换" 仍然兼容, 但正则里含 "=" 时必须用 "=>")
 */

const util = require('../util.js');
const config = require('../config.js');
const registry = require('./registry.js');
const permissions = require('../permissions.js');
const builtin = require('./builtin.js');

const S = 'rule';
const REGISTERED = [];

/** 把 "名字:说明,名字2:说明2" 解析成参数数组 */
function parseArgs(text) {
    return config.toList(text).map(function (item) {
        const s = String(item);
        const i = s.indexOf(':');
        const name = util.sanitizeToolName(i < 0 ? s : s.slice(0, i));
        const desc = i < 0 ? '' : util.trim(s.slice(i + 1));
        return name ? { name: name, desc: desc } : null;
    }).filter(Boolean);
}

/** 解析配置 → 规则数组 */
function parseRules() {
    const raw = util.trim(config.get().tools.commandRules);
    if (!raw) return [];
    const out = [];

    // JSON 形式
    if (raw[0] === '[' || raw[0] === '{') {
        const parsed = util.safeJson(raw, null);
        const list = Array.isArray(parsed) ? parsed : (parsed && parsed.rules) || null;
        if (Array.isArray(list)) {
            list.forEach(function (it) {
                if (!it || !util.trim(it.command)) return;
                out.push({
                    name: util.sanitizeToolName(it.name || it.title || ''),
                    title: util.trim(it.title || it.name || ''),
                    command: util.trim(it.command),
                    args: (it.args || []).map(function (a) {
                        return { name: util.sanitizeToolName(a.name || a), desc: util.trim(a.desc || '') };
                    }).filter(function (a) { return a.name; }),
                    level: (it.level === undefined || it.level === null || it.level === '') ? null : Number(it.level)
                });
            });
        }
        return out;
    }

    // 行式: 工具名|标题|指令|参数|等级
    raw.split(/\r?\n/).forEach(function (line) {
        const t = util.trim(line);
        if (!t || t.indexOf('#') === 0) return;
        const parts = t.split('|').map(function (x) { return util.trim(x); });
        const command = parts[2] || '';
        if (!command) return;
        out.push({
            name: util.sanitizeToolName(parts[0] || ''),
            title: parts[1] || parts[0] || '',
            command: command,
            args: parseArgs(parts[3] || ''),
            level: parts[4] === undefined || parts[4] === '' ? null : Number(parts[4])
        });
    });
    return out;
}

/** 从指令模板里推断参数（模板里出现但参数列没写的 {xxx}） */
function argsOf(rule) {
    const found = [];
    const re = /\{([A-Za-z0-9_]+)\}/g;
    let m;
    while ((m = re.exec(rule.command))) {
        const n = util.sanitizeToolName(m[1]);
        if (n && !found.some(function (a) { return a.name === n; })) found.push({ name: n, desc: '' });
    }
    return rule.args.length ? rule.args.concat(found.filter(function (f) {
        return !rule.args.some(function (a) { return a.name === f.name; });
    })) : found;
}

/** 渲染指令模板 */
function render(rule, args) {
    return String(rule.command).replace(/\{([A-Za-z0-9_]+)\}/g, function (all, key) {
        const v = args && args[key] !== undefined && args[key] !== null ? String(args[key]) : '';
        return v;
    });
}

/** 解析改写规则 → [{re, to, raw}] */
function parseRewrites() {
    const raw = util.trim(config.get().tools.commandRewrites);
    if (!raw) return [];
    const out = [];
    raw.split(/\r?\n/).forEach(function (line) {
        const t = util.trim(line);
        if (!t || t.indexOf('#') === 0) return;
        // 分隔符优先用 "=>" —— 正则里经常含 "=" (例如 (?=\s|$) 前瞻),
        // 用 "=" 切会把正则切坏。所以 "=>" 优先, 再退回第一个 "="。
        let i = t.indexOf('=>');
        let skip = 2;
        if (i < 0) { i = t.indexOf('='); skip = 1; }
        if (i < 0) return;
        const from = util.trim(t.slice(0, i));
        const to = util.trim(t.slice(i + skip));
        if (!from) return;
        try {
            out.push({ re: new RegExp(from, 'i'), to: to, raw: t });
        } catch (e) {
            if (typeof logger !== 'undefined' && logger) {
                logger.warning('[ai-chat] 指令改写规则正则无效, 已跳过: {0}', t);
            }
        }
    });
    return out;
}

/**
 * 对一条指令应用改写规则。
 * @returns {{command:string, changed:boolean, rule:string}}
 */
function applyRewrites(command) {
    let cmd = String(command || '');
    let changed = false;
    let used = '';
    parseRewrites().forEach(function (r) {
        if (r.re.test(cmd)) {
            cmd = cmd.replace(r.re, r.to);
            changed = true;
            used = r.raw;
        }
    });
    return { command: cmd, changed: changed, rule: used };
}

/** 工具名(加前缀避免和其它插件冲突) */
function toolNameOf(rule, idx) {
    const base = rule.name || ('rule_' + (idx + 1));
    return 'eb_' + util.sanitizeToolName(base).replace(/^eb_/, '');
}

/** 注册所有规则工具 */
function registerAll() {
    unregisterAll();
    const rules = parseRules();
    let ok = 0;
    rules.forEach(function (rule, idx) {
        const name = toolNameOf(rule, idx);
        const args = argsOf(rule);
        const props = {};
        args.forEach(function (a) {
            props[a.name] = { type: 'string', description: a.desc || ('参数 ' + a.name) };
        });
        const argText = args.length
            ? '参数: ' + args.map(function (a) { return a.name + (a.desc ? '(' + a.desc + ')' : ''); }).join(', ')
            : '无需参数';
        try {
            registry.register({
                name: name,
                description: (rule.title || '自定义指令') + '。本服对应指令: ' + rule.command +
                    '。' + argText + '。当用户表达这个意图时调用它(不要自己拼指令)。',
                parameters: { type: 'object', properties: props, required: args.map(function (a) { return a.name; }) },
                source: S, plugin: 'eb', qualify: false,
                meta: { isRule: true, rule: rule },
                handler: async function (a, ctx) {
                    const tcfg = config.get().tools;
                    if (!tcfg.allowRunCommand) throw new Error('管理员已关闭"允许执行服务器命令"');

                    const cmd = render(rule, a || {});
                    if (!cmd) throw new Error('指令模板渲染结果为空');

                    // 等级: 规则指定优先, 否则按常规分类
                    const level = permissions.levelOf(ctx);
                    let verdict;
                    if (rule.level !== null && !isNaN(rule.level)) {
                        verdict = level >= rule.level
                            ? { ok: true, tier: 'rule', need: rule.level, reason: '规则指定等级 ' + rule.level }
                            : {
                                ok: false, tier: 'rule', need: rule.level,
                                reason: '这个操作需要等级 ' + rule.level + ', 你是 ' + level
                            };
                    } else {
                        verdict = permissions.check(level, cmd);
                    }
                    if (!verdict.ok) {
                        logger.info('[ai-chat] 拒绝规则指令(等级 {0}): {1} —— {2}', level, cmd, verdict.reason);
                        return {
                            success: false, denied: true, command: cmd,
                            yourLevel: level, yourLevelName: permissions.levelName(level),
                            neededLevel: verdict.need, reason: verdict.reason,
                            hint: '不要重试。告诉对方权限不足并说明需要什么等级。'
                        };
                    }

                    const server = builtin.resolveServer(a && a.serverToken);
                    const exec = await builtin.resolveExecutor({}, ctx, server);
                    const usePapi = builtin.shouldUsePapi(tcfg, await builtin.isPlayerOnline(server, exec.name), cmd);
                    const packet = await server.bridge.SendRunCommandAsync(exec.name, cmd, usePapi);
                    const output = builtin.cleanOutput((packet && packet.Text) || '');
                    logger.info('[ai-chat] 执行规则指令(等级 {0}, 身份 {1}): {2} -> {3}',
                        level, exec.name, cmd, util.truncate(output.replace(/\s+/g, ' '), 120));
                    return {
                        success: !(packet && packet.Success === false),
                        intent: rule.title,
                        command: cmd,
                        server: server.name,
                        executedAs: exec.name,
                        output: output,
                        hasOutput: !!util.trim(output),
                        level: level,
                        tier: 'rule',
                        note: exec.note || ''
                    };
                }
            });
            REGISTERED.push(name);
            ok++;
        } catch (e) {
            logger.warning('[ai-chat] 注册指令规则失败 {0}: {1}', name, (e && e.message) || e);
        }
    });
    if (ok) logger.info('[ai-chat] 已注册 {0} 条自定义指令规则: {1}', ok, REGISTERED.join(', '));
    return ok;
}

function unregisterAll() {
    REGISTERED.splice(0).forEach(function (n) { registry.unregister(n); });
}

/** 给提示词用: 告诉模型优先用这些规则工具 */
function describeForPrompt() {
    const rules = parseRules();
    if (!rules.length) return '';
    const lines = rules.map(function (r, i) {
        return '- ' + toolNameOf(r, i) + ': ' + (r.title || '') + ' -> ' + r.command;
    });
    const rw = parseRewrites();
    let text = '\n本服已配置的专用指令工具(对应本服实际指令, 优先用它们, 不要自己拼指令):\n' + lines.join('\n');
    if (rw.length) {
        text += '\n本服指令改写规则(经过 eb_run_command 的指令会自动改写): ' +
            rw.map(function (r) { return r.raw; }).join('; ');
    }
    return text;
}

module.exports = {
    parseRules: parseRules,
    parseRewrites: parseRewrites,
    applyRewrites: applyRewrites,
    render: render,
    argsOf: argsOf,
    registerAll: registerAll,
    unregisterAll: unregisterAll,
    describeForPrompt: describeForPrompt,
    registered: function () { return REGISTERED.slice(); }
};
