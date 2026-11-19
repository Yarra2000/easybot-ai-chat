'use strict';

/**
 * 指令权限模块。
 *
 * 目标: 玩家用自然语言提需求 → 大模型决定执行哪条 MC 指令 → **按调用者身份分级校验**
 *      → 执行 → 把服务器控制台输出回给模型 → 模型用人话回答。
 *
 * 等级模型:
 *   0 = 禁止执行任何指令
 *   1 = 只能执行 safeCommands(安全指令)
 *   2 = 还能执行 mediumCommands(普通指令)
 *   3 = 除硬黑名单外都能执行(高危)
 *
 * 判定顺序(从严到宽):
 *   硬黑名单(tools.commandBlacklist) → 任何等级都拒绝
 *   safeCommands 命中   → 需要 >= 1 (由 permissions.safeLevel 可调)
 *   mediumCommands 命中 → 需要 >= 2
 *   其它(未列出)        → 需要 >= permissions.unknownCommandLevel(默认 3, 即默认按高危处理)
 *
 * 身份来源(优先级):
 *   1. permissions.userLevels 里显式配置的 QQ("QQ:等级, QQ:等级")
 *   2. permissions.users 对象 { "QQ": 等级 }
 *   3. 群身份: 群主 → groupOwnerLevel, 群管理 → groupAdminLevel
 *   4. 兜底: defaultLevel(默认 0, 即陌生人不能用指令)
 */

const util = require('./util.js');
const config = require('./config.js');
const cmdbook = require('./cmdbook.js');

const LEVEL_NAMES = { 0: '禁止用指令', 1: '安全指令', 2: '普通指令', 3: '高危指令' };

/** 把 userLevels 字符串 / users 对象统一成 { qq: level } */
function userMap() {
    const cfg = config.permissions() || {};
    const out = {};

    config.toList(cfg.userLevels).forEach(function (item) {
        const i = String(item).indexOf(':');
        if (i < 0) return;
        const qq = util.trim(String(item).slice(0, i));
        const lv = Number(util.trim(String(item).slice(i + 1)));
        if (qq) out[qq] = isNaN(lv) ? 0 : lv;
    });

    const users = cfg.users;
    if (users && typeof users === 'object') {
        try {
            Object.keys(users).forEach(function (k) {
                if (['GetType', 'ToString', 'Equals', 'GetHashCode'].indexOf(k) >= 0) return;
                const lv = Number(users[k]);
                if (String(k)) out[String(k)] = isNaN(lv) ? 0 : lv;
            });
        } catch (e) { /* ignore */ }
    }
    return out;
}

/**
 * 按群分类的等级表。
 * 配置格式(每行一个群):  群号 | QQ:等级, QQ:等级
 *   例: 123456789 | 100000001:3, 100000006:2
 * 也可以写成 JSON: { "123456789": { "100000001": 3 } }
 */
function groupMap() {
    const raw = util.trim((config.permissions() || {}).groupScopes);
    const out = {};
    if (!raw) return out;

    if (raw[0] === '{') {
        const parsed = util.safeJson(raw, null);
        if (parsed && typeof parsed === 'object') {
            Object.keys(parsed).forEach(function (g) {
                if (['GetType', 'ToString', 'Equals', 'GetHashCode'].indexOf(g) >= 0) return;
                const inner = parsed[g];
                if (!inner || typeof inner !== 'object') return;
                out[String(g)] = out[String(g)] || {};
                Object.keys(inner).forEach(function (q) {
                    const lv = Number(inner[q]);
                    if (String(q)) out[String(g)][String(q)] = isNaN(lv) ? 0 : lv;
                });
            });
        }
        return out;
    }

    raw.split(/\r?\n/).forEach(function (line) {
        const t = util.trim(line);
        if (!t || t[0] === '#') return;
        const i = t.indexOf('|');
        if (i < 0) return;
        const g = util.trim(t.slice(0, i));
        if (!g) return;
        out[g] = out[g] || {};
        config.toList(t.slice(i + 1)).forEach(function (item) {
            const j = String(item).indexOf(':');
            if (j < 0) return;
            const qq = util.trim(String(item).slice(0, j));
            const lv = Number(util.trim(String(item).slice(j + 1)));
            if (qq) out[g][qq] = isNaN(lv) ? 0 : lv;
        });
    });
    return out;
}

/** 解析调用者的等级 */
function levelOf(ctx) {
    const cfg = config.permissions() || {};
    if (cfg.enabled === false) return 3;                 // 权限系统关掉 = 不做限制(不建议)
    if (ctx && ctx.level !== undefined && ctx.level !== null && ctx.level !== '') {
        const forced = Number(ctx.level);
        if (!isNaN(forced)) return forced;               // 显式指定(测试/其它插件调用)
    }
    const sid = String((ctx && ctx.senderId) || '');

    // ① 按群分类的显式配置(优先) —— 同一个人在 A 群可以是管理, 在 B 群只是普通群友
    const gid = String((ctx && (ctx.peerId || ctx.groupId)) || '');
    if (sid && gid) {
        const perGroup = groupMap()[gid];
        if (perGroup && perGroup[sid] !== undefined) return Number(perGroup[sid]);
    }

    // ② 全局显式配置
    const map = userMap();
    if (sid && map[sid] !== undefined) return Number(map[sid]);

    const role = String((ctx && ctx.senderRole) || '').toLowerCase();
    if (role === 'owner' && cfg.groupOwnerLevel !== undefined && cfg.groupOwnerLevel !== null && cfg.groupOwnerLevel !== '') {
        return Number(cfg.groupOwnerLevel) || 0;
    }
    if (role === 'admin' && cfg.groupAdminLevel !== undefined && cfg.groupAdminLevel !== null && cfg.groupAdminLevel !== '') {
        return Number(cfg.groupAdminLevel) || 0;
    }
    const def = (cfg.defaultLevel === undefined || cfg.defaultLevel === null || cfg.defaultLevel === '')
        ? 0 : Number(cfg.defaultLevel);
    return isNaN(def) ? 0 : def;
}

function levelName(level) {
    return LEVEL_NAMES[Number(level)] || ('等级 ' + level);
}

/** 规范化指令文本 */
function normalizeCommand(command) {
    return util.trim(String(command === null || command === undefined ? '' : command))
        .replace(/^\//, '')
        .replace(/\s+/g, ' ');
}

/** 是否是硬黑名单 */
function isBlacklisted(command) {
    const list = config.get().tools.commandBlacklist || [];
    const cmd = normalizeCommand(command).toLowerCase();
    const head = cmd.split(' ')[0];
    return list.some(function (x) {
        const p = util.trim(String(x)).toLowerCase();
        return p && (p === head || p === cmd);
    });
}

/** 命中了哪个清单(支持 "time query" 这种带空格的前缀) */
function matchList(command, list) {
    const cmd = normalizeCommand(command).toLowerCase();
    return (list || []).some(function (x) {
        const p = util.trim(String(x)).toLowerCase();
        if (!p) return false;
        return cmd === p || cmd.indexOf(p + ' ') === 0;
    });
}

/**
 * 校验一条指令能不能由该等级执行
 * @returns {{ok:boolean, tier:string, need:number, reason:string}}
 */
function check(level, command) {
    const cfg = config.permissions() || {};
    const cmd = normalizeCommand(command);
    const lv = Number(level) || 0;

    if (!cmd) return { ok: false, tier: 'empty', need: 0, reason: '指令为空' };
    if (/\n|\r/.test(cmd)) return { ok: false, tier: 'invalid', need: 0, reason: '指令里不允许换行' };

    if (isBlacklisted(cmd)) {
        return { ok: false, tier: 'blocked', need: 99, reason: '指令 "' + cmd.split(' ')[0] + '" 在硬黑名单里, 任何人都不能执行' };
    }

    // 知识库里显式写了等级就以它为准(管理员在 WebUI 里写几级就是几级)
    try {
        const bookLevel = cmdbook.levelOf(cmd);
        if (bookLevel !== null && !isNaN(bookLevel)) {
            return lv >= bookLevel
                ? { ok: true, tier: 'book', need: bookLevel, reason: '知识库声明等级 ' + bookLevel }
                : {
                    ok: false, tier: 'book', need: bookLevel,
                    reason: '这条指令按本服指令知识库需要等级 ' + bookLevel + ', 你是 ' + lv
                };
        }
    } catch (e) { /* ignore */ }

    const safeLevel = Number(cfg.safeLevel === undefined ? 1 : cfg.safeLevel);
    if (matchList(cmd, cfg.safeCommands)) {
        return lv >= safeLevel
            ? { ok: true, tier: 'safe', need: safeLevel, reason: '安全指令' }
            : { ok: false, tier: 'safe', need: safeLevel, reason: '这是安全指令, 但你的等级(' + lv + ')不足, 需要 ' + safeLevel };
    }

    if (matchList(cmd, cfg.mediumCommands)) {
        const need = Number(cfg.mediumLevel === undefined ? 2 : cfg.mediumLevel);
        return lv >= need
            ? { ok: true, tier: 'medium', need: need, reason: '普通指令' }
            : { ok: false, tier: 'medium', need: need, reason: '这是普通指令, 需要等级 ' + need + ', 你是 ' + lv };
    }

    const need = Number(cfg.unknownCommandLevel === undefined ? 3 : cfg.unknownCommandLevel);
    return lv >= need
        ? { ok: true, tier: 'unknown', need: need, reason: '未列出的指令, 按高危处理' }
        : {
            ok: false, tier: 'unknown', need: need,
            reason: '指令 "' + cmd.split(' ')[0] + '" 不在安全清单里, 按高危处理, 需要等级 ' + need + ', 你是 ' + lv
        };
}

/**
 * 生成"按群分类"的权限总览, 供 WebUI 展示。
 * @param {string[]} groups 要展示的群号列表(一般来自 access.allowGroupIds)
 * @param {object} names   可选的 QQ->昵称 / 群号->群名 映射
 */
function overview(groups, names) {
    const cfg = config.permissions() || {};
    const gmap = groupMap();
    const umap = userMap();
    const ownerLv = (cfg.groupOwnerLevel === undefined || cfg.groupOwnerLevel === null || cfg.groupOwnerLevel === '')
        ? 0 : Number(cfg.groupOwnerLevel);
    const adminLv = (cfg.groupAdminLevel === undefined || cfg.groupAdminLevel === null || cfg.groupAdminLevel === '')
        ? 0 : Number(cfg.groupAdminLevel);
    const defLv = (cfg.defaultLevel === undefined || cfg.defaultLevel === null || cfg.defaultLevel === '')
        ? 0 : Number(cfg.defaultLevel);

    const list = [];
    const seen = {};
    (groups || []).forEach(function (g) {
        g = String(g || '');
        if (g && !seen[g]) { seen[g] = 1; list.push(g); }
    });
    Object.keys(gmap).forEach(function (g) { if (!seen[g]) { seen[g] = 1; list.push(g); } });

    return {
        defaultLevel: defLv,
        ownerLevel: ownerLv,
        adminLevel: adminLv,
        levelNames: LEVEL_NAMES,
        globalUsers: Object.keys(umap).map(function (qq) {
            return { qq: qq, level: umap[qq], name: (names && names[qq]) || '' };
        }),
        groups: list.map(function (g) {
            const inner = gmap[g] || {};
            const members = Object.keys(inner).map(function (qq) {
                return { qq: qq, level: inner[qq], name: (names && names[qq]) || '' };
            }).sort(function (a, b) { return b.level - a.level; });
            return {
                groupId: g,
                groupName: (names && names[g]) || '',
                owner: ownerLv,
                admin: adminLv,
                others: defLv,
                members: members
            };
        })
    };
}

/** 给模型看的一段权限说明 */
function describeFor(ctx) {
    const level = levelOf(ctx);
    const cfg = config.permissions() || {};
    const safe = (cfg.safeCommands || []).slice(0, 12).join('/');
    const parts = ['等级 ' + level + '(' + levelName(level) + ')'];
    if (level >= 3) parts.push('可以执行除黑名单外的任意指令');
    else if (level >= 2) parts.push('只能执行安全与普通指令: ' + (safe || '(未配置)'));
    else if (level >= 1) parts.push('只能执行安全指令: ' + (safe || '(未配置)'));
    else parts.push('不能执行任何服务器指令');
    return parts.join('; ');
}

module.exports = {
    LEVEL_NAMES: LEVEL_NAMES,
    levelOf: levelOf,
    groupMap: groupMap,
    overview: overview,
    levelName: levelName,
    userMap: userMap,
    normalizeCommand: normalizeCommand,
    isBlacklisted: isBlacklisted,
    matchList: matchList,
    check: check,
    describeFor: describeFor
};
