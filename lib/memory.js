'use strict';

/**
 * 记忆模块 (仿 MaiBot 的"短期上下文 + 长期记忆")。
 *
 * 数据全部落在 EasyBot 提供的 litedb 里 (每个插件独立数据库文件)。
 * 如果运行环境里没有 litedb, 自动降级为进程内内存存储, 保证插件不崩。
 *
 * 集合说明:
 *   context : key = 会话键(g:群号 / d:用户号)  value = { messages: [...], updated }
 *   facts   : key = fact_<id>                 value = { id, text, scope, owner, session, ts }
 *   state   : key = 会话键                     value = { lastReplyAt, lastSenderId, turns }
 *   settings: 杂项开关 (persona_override / <会话键>_enabled 等)
 */

const util = require('./util.js');
const config = require('./config.js');

// ---------------------------------------------------------------- 存储适配层

const _mem = {};

function _hasLiteDb() {
    return typeof litedb !== 'undefined' && litedb && typeof litedb.Set === 'function';
}

/**
 * 写入。**存的是 JSON 字符串**。
 *
 * 实测踩坑: 直接 litedb.Set(collection, key, <JS对象>) 在真实 EasyBot 上写不进去
 * (数据库文件里连字段名都没有, 只有集合名和一个空的 value), 于是"群上下文/记忆"
 * 在真机上等于从未持久化 —— 图片回看也因此拿不到历史图片。
 * 改成字符串后一定可序列化, 同时兼容读回旧格式。
 */
function storeSet(collection, key, value) {
    try {
        if (_hasLiteDb()) return litedb.Set(collection, key, util.safeStringify(value));
    } catch (e) {
        try { logger.warning('[ai-chat] litedb 写入失败: {0}', e && e.message ? e.message : e); } catch (x) { }
    }
    _mem[collection] = _mem[collection] || {};
    _mem[collection][key] = util.clone(value);
    return true;
}

function storeGet(collection, key, def) {
    const fallback = def === undefined ? null : def;
    try {
        if (_hasLiteDb()) {
            const v = litedb.Get(collection, key);
            if (v === null || v === undefined) return fallback;
            // 正常情况: JSON 字符串
            if (typeof v === 'string') {
                const parsed = util.safeJson(v, undefined);
                if (parsed !== undefined) return parsed;
                return fallback;
            }
            // 兼容: 如果宿主直接返回了对象(旧格式), 直接用
            if (typeof v === 'object') {
                for (const k of Object.keys(v)) {   // 排除 .NET 代理的方法噪声
                    if (k !== 'GetType' && k !== 'ToString' && k !== 'Equals' && k !== 'GetHashCode') return v;
                }
                return fallback;
            }
            return v;
        }
    } catch (e) { /* fallthrough */ }
    const bucket = _mem[collection];
    if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) return util.clone(bucket[key]);
    return fallback;
}

function storeDelete(collection, key) {
    try {
        if (_hasLiteDb()) return litedb.Delete(collection, key);
    } catch (e) { /* ignore */ }
    const bucket = _mem[collection];
    if (bucket) delete bucket[key];
    return true;
}

function storeKeys(collection) {
    try {
        if (_hasLiteDb()) {
            const keys = litedb.GetKeys(collection);
            return util.toArray(keys).map(String);
        }
    } catch (e) { /* ignore */ }
    return Object.keys(_mem[collection] || {});
}

function storeClear(collection) {
    try {
        if (_hasLiteDb()) return litedb.Clear(collection);
    } catch (e) { /* ignore */ }
    _mem[collection] = {};
    return true;
}

// ---------------------------------------------------------------- 会话上下文

/** 生成会话键 */
function sessionKey(kind, id) {
    return (kind === 'group' ? 'g:' : 'd:') + String(id);
}

/** 从会话键解析出类型与 ID */
function parseSessionKey(key) {
    const s = String(key || '');
    if (s.indexOf('g:') === 0) return { kind: 'group', id: s.slice(2) };
    if (s.indexOf('d:') === 0) return { kind: 'direct', id: s.slice(2) };
    return { kind: 'unknown', id: s };
}

/** 读取上下文 */
function getContext(key) {
    const ctx = storeGet('context', key, null);
    if (!ctx || typeof ctx !== 'object') return { messages: [], updated: 0 };
    if (!Array.isArray(ctx.messages)) ctx.messages = [];
    return ctx;
}

/** 追加一条消息并做裁剪 */
function appendMessage(key, msg) {
    const cfg = config.get().memory;
    const ctx = getContext(key);
    const entry = {
        role: msg.role,
        name: msg.name || '',
        content: String(msg.content === null || msg.content === undefined ? '' : msg.content),
        ts: msg.ts || util.now()
    };
    // 图片 URL 单独存, 供"先发图再@机器人问"的场景回看
    if (msg.images && msg.images.length) entry.images = msg.images.slice(0, 6);
    // 消息 ID, 用于解析"用户引用(回复)了哪条消息"
    if (msg.msgId) entry.msgId = String(msg.msgId);
    ctx.messages.push(entry);

    // 条数裁剪
    const maxMessages = Math.max(2, Number(cfg.maxMessages) || 24);
    while (ctx.messages.length > maxMessages) ctx.messages.shift();

    // 字符数裁剪
    const maxChars = Math.max(200, Number(cfg.maxChars) || 6000);
    let total = 0;
    for (let i = 0; i < ctx.messages.length; i++) total += ctx.messages[i].content.length;
    while (total > maxChars && ctx.messages.length > 2) {
        const removed = ctx.messages.shift();
        total -= removed.content.length;
    }

    ctx.updated = util.now();
    storeSet('context', key, ctx);
    return ctx;
}

/**
 * 防止模型"续写聊天记录"的硬性约束。
 *
 * 实测踩坑: 如果把群聊历史以「昵称：内容」的形式当普通 user 消息喂进去,
 * 模型有时会把这当成需要接续的文本, 输出
 *   "Gamer: @小助手 ai 服务器有几个人？\n(等待小助手回复)"
 * 这种"复述+旁白"而不是回复。这里用 块状背景 + 显式当前消息 + 硬性格式要求 来消除这个诱导。
 */
const ANTI_ECHO = [
    '',
    '【输出约定】',
    '你的输出会被原样当作一条群消息发出去, 所以:',
    '- 只写你这一轮要说的话, 不要写"昵称："前缀, 不要写旁白或括号说明。',
    '- 不要复述、引用或续写聊天记录; 记录里的旧消息不用再回答。',
    '- 需要真实数据时直接调用工具, 拿到结果后用日常口语说出结论。',
    '- 不要只回"稍等""正在查"这类占位话。'
].join('\n');

/** 放在最后一条 user 消息里的"行动指令" (参考 MaiBot 的做法) */
const REPLY_NOW = '请自然地回复这条消息, 只输出你要发送的内容, 不要输出多余说明或标记。';

/**
 * 组装喂给大模型的消息列表。
 *
 * @param {string} key 会话键
 * @param {string} systemPrompt 系统提示词(人设/场景/工具/输出要求)
 * @param {object} [opts]
 * @param {{name?:string, content:string}} [opts.current] 本轮需要回复的消息
 * @param {{name?:string, content:string}} [opts.quoted] 本轮消息所引用(回复)的那条消息
 * @param {string} [opts.extraUser] 额外追加的一条 user 消息
 *
 * historyMode:
 *   'context'(默认) 历史作为「群聊记录」块放进 system, 当前消息单独作为唯一的 user 轮
 *   'turns'         历史按 user/assistant 轮次发送, 当前消息加【现在轮到你了】标记
 */
function buildMessages(key, systemPrompt, opts) {
    opts = opts || {};
    const memCfg = config.get().memory || {};
    const mode = (memCfg.historyMode === 'turns') ? 'turns' : 'context';
    const ctx = getContext(key);
    const maxMessages = Math.max(2, Number(memCfg.maxMessages) || 24);
    let recent = ctx.messages.slice(-maxMessages);

    // 决定"本轮要回复的消息"
    let current = opts.current || null;
    if (current) {
        // 历史里最后一条就是它, 从背景里去掉, 避免重复
        if (recent.length && recent[recent.length - 1].role === 'user') recent = recent.slice(0, -1);
    } else if (recent.length && recent[recent.length - 1].role === 'user') {
        current = recent[recent.length - 1];
        recent = recent.slice(0, -1);
    }

    const label = function (m) { return m.name ? (m.name + '：') : ''; };
    let currentText = current ? ('【现在轮到你了】' + label(current) + current.content) : '';
    // 引用了某条消息时, 把被引用的内容明确告诉模型, 否则它只能从一坨历史里猜
    if (opts.quoted && (opts.quoted.content || opts.quoted.images)) {
        const qc = opts.quoted.content || (opts.quoted.images && opts.quoted.images.length ? '[图片]' : '');
        currentText += '\n\n【他引用的那条消息】' + label(opts.quoted) + qc;
        if (!qc) currentText += '(内容未知, 可能不在最近的聊天记录里)';
    }

    if (mode === 'turns') {
        const out = [{ role: 'system', content: systemPrompt + ANTI_ECHO }];
        recent.forEach(function (m) {
            if (m.role === 'assistant') out.push({ role: 'assistant', content: m.content });
            else out.push({ role: 'user', content: label(m) + m.content });
        });
        if (current) out.push({ role: 'user', content: currentText + '\n\n（' + REPLY_NOW + '）' });
        if (opts.extraUser) out.push({ role: 'user', content: opts.extraUser });
        return out;
    }

    // context 模式: 约定放在前面, 背景块在后; 当前消息作为唯一的 user 轮并带行动指令
    const log = recent.map(function (m) {
        return (m.role === 'assistant' ? (config.persona().name || '你') : (m.name || '某人')) + '：' + m.content;
    }).join('\n');
    const sys = systemPrompt + ANTI_ECHO +
        '\n\n【近期群聊记录】(只是背景, 帮你把握话题)' +
        '\n' + (log || '(暂无)') +
        '\n\n下面这条才是需要你回复的消息。';
    const out = [{ role: 'system', content: sys }];
    if (current) out.push({ role: 'user', content: currentText + '\n\n（' + REPLY_NOW + '）' });
    if (opts.extraUser) out.push({ role: 'user', content: opts.extraUser });
    return out;
}

/**
 * 按消息 ID 找到历史里的那条消息 (用于解析"引用了哪条消息")。
 * @returns {object|null}
 */
function findByMessageId(key, msgId) {
    const id = String(msgId || '');
    if (!id) return null;
    const ctx = getContext(key);
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m && m.msgId && String(m.msgId) === id) return m;
    }
    return null;
}

/**
 * 回看最近若干秒内出现过的图片 URL。
 * 场景: QQ 里常见"先发一张图, 隔几秒再 @机器人 问这是啥", 图片和问题不在同一条消息里。
 * @returns {string[]} 最新的在前
 */
function recentImages(key, seconds, limit) {
    const out = [];
    const max = Math.max(1, Number(limit) || 2);
    const deadline = util.now() - Math.max(1, Number(seconds) || 180) * 1000;
    const ctx = getContext(key);
    for (let i = ctx.messages.length - 1; i >= 0 && out.length < max; i--) {
        const m = ctx.messages[i];
        if (!m || !m.images || !m.images.length) continue;
        if (m.ts && m.ts < deadline) break;
        for (let j = m.images.length - 1; j >= 0 && out.length < max; j--) {
            const u = String(m.images[j]);
            if (out.indexOf(u) < 0) out.push(u);
        }
    }
    return out;
}

/**
 * 把图片描述写回最近一条带图片的消息里 (学 MaiBot: VLM 描述一次, 文字进上下文)。
 * 这样后续即使超出"图片回看"窗口, 模型也能从历史里看到图片内容。
 * @returns {boolean} 是否更新成功
 */
function annotateLastImages(key, description) {
    const text = util.trim(description);
    if (!text) return false;
    const ctx = getContext(key);
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const m = ctx.messages[i];
        if (m && m.images && m.images.length) {
            if (String(m.content).indexOf('[图片:') >= 0) return false;   // 已经有描述了
            m.content = String(m.content).replace('[图片]', '[图片: ' + util.truncate(text, 120) + ']');
            if (m.content.indexOf('[图片:') < 0) m.content += ' [图片: ' + util.truncate(text, 120) + ']';
            m.described = true;
            ctx.updated = util.now();
            storeSet('context', key, ctx);
            return true;
        }
    }
    return false;
}

/** 清空某个会话的上下文 */
function clearContext(key) {
    storeDelete('context', key);
    return true;
}

/** 清空全部上下文 */
function clearAllContexts() {
    return storeClear('context');
}

/** 会话运行时状态 (冷却/连续对话判断) */
function getState(key) {
    const st = storeGet('state', key, null);
    if (!st || typeof st !== 'object') return { lastReplyAt: 0, lastSenderId: '', turns: 0 };
    return st;
}

function setState(key, patch) {
    const st = getState(key);
    Object.keys(patch || {}).forEach(function (k) { st[k] = patch[k]; });
    storeSet('state', key, st);
    return st;
}

// ---------------------------------------------------------------- 长期记忆

/** 新增一条长期记忆 */
function addFact(text, opts) {
    opts = opts || {};
    const clean = util.trim(text);
    if (!clean) return null;
    const id = 'f' + util.now().toString(36) + util.shortId();
    const fact = {
        id: id,
        text: util.truncate(clean, 500),
        scope: opts.scope || 'user',   // user | session | global
        owner: opts.owner ? String(opts.owner) : '',
        session: opts.session ? String(opts.session) : '',
        ts: util.now()
    };
    storeSet('facts', 'fact_' + id, fact);
    return fact;
}

/** 获取全部记忆 */
function allFacts() {
    const keys = storeKeys('facts').filter(function (k) { return k.indexOf('fact_') === 0; });
    const out = [];
    keys.forEach(function (k) {
        const f = storeGet('facts', k, null);
        if (f && f.text) out.push(f);
    });
    out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return out;
}

/**
 * 取出与当前会话/用户相关的记忆
 * @param {{owner?: string, session?: string, limit?: number}} opts
 */
function getRelevantFacts(opts) {
    opts = opts || {};
    const cfg = config.get().memory;
    const limit = Math.max(1, Number(opts.limit) || Number(cfg.maxFactsPerUser) || 12);
    const owner = opts.owner ? String(opts.owner) : '';
    const session = opts.session ? String(opts.session) : '';
    const list = allFacts().filter(function (f) {
        if (f.scope === 'global') return true;
        if (f.scope === 'session' && session && String(f.session) === session) return true;
        if (f.scope === 'user' && owner && String(f.owner) === owner) return true;
        return false;
    });
    return list.slice(0, limit);
}

/** 关键词搜索记忆 */
function searchFacts(keyword, limit) {
    const kw = util.trim(keyword);
    const list = allFacts();
    if (!kw) return list.slice(0, limit || 10);
    return list.filter(function (f) { return util.containsIgnoreCase(f.text, kw); }).slice(0, limit || 10);
}

/** 删除记忆 */
function forgetFact(id) {
    const key = 'fact_' + String(id || '').replace(/^fact_/, '');
    const existed = storeGet('facts', key, null);
    storeDelete('facts', key);
    return !!existed;
}

/** 清空记忆 (可按用户/会话过滤) */
function clearFacts(filter) {
    filter = filter || {};
    const keys = storeKeys('facts').filter(function (k) { return k.indexOf('fact_') === 0; });
    let removed = 0;
    keys.forEach(function (k) {
        const f = storeGet('facts', k, null);
        if (!f) return;
        if (filter.owner && String(f.owner) !== String(filter.owner)) return;
        if (filter.session && String(f.session) !== String(filter.session)) return;
        storeDelete('facts', k);
        removed++;
    });
    return removed;
}

/** 会话级开关 (由 /ai on|off 写入) */
function isSessionEnabled(key) {
    const v = storeGet('settings', key + '_enabled', null);
    if (v === null || v === undefined) return true;
    return v !== false;
}

function setSessionEnabled(key, enabled) {
    storeSet('settings', key + '_enabled', !!enabled);
}

// ---------------------------------------------------------------- 统计/清理

function stats() {
    const ctxKeys = storeKeys('context');
    let msgCount = 0;
    ctxKeys.forEach(function (k) {
        const c = storeGet('context', k, null);
        if (c && Array.isArray(c.messages)) msgCount += c.messages.length;
    });
    return {
        sessions: ctxKeys.length,
        messages: msgCount,
        facts: allFacts().length,
        backend: _hasLiteDb() ? 'litedb' : 'memory'
    };
}

/** 清理过期上下文 */
function gc() {
    try {
        const ttlHours = Number(config.get().memory.contextTtlHours) || 72;
        const deadline = util.now() - ttlHours * 3600 * 1000;
        let removed = 0;
        storeKeys('context').forEach(function (k) {
            const c = storeGet('context', k, null);
            if (c && c.updated && c.updated < deadline) {
                storeDelete('context', k);
                removed++;
            }
        });
        return removed;
    } catch (e) {
        return 0;
    }
}

module.exports = {
    ANTI_ECHO: ANTI_ECHO,
    REPLY_NOW: REPLY_NOW,
    sessionKey: sessionKey,
    parseSessionKey: parseSessionKey,
    getContext: getContext,
    appendMessage: appendMessage,
    buildMessages: buildMessages,
    findByMessageId: findByMessageId,
    recentImages: recentImages,
    annotateLastImages: annotateLastImages,
    clearContext: clearContext,
    clearAllContexts: clearAllContexts,
    getState: getState,
    setState: setState,
    addFact: addFact,
    allFacts: allFacts,
    getRelevantFacts: getRelevantFacts,
    searchFacts: searchFacts,
    forgetFact: forgetFact,
    clearFacts: clearFacts,
    isSessionEnabled: isSessionEnabled,
    setSessionEnabled: setSessionEnabled,
    stats: stats,
    gc: gc,
    _store: { set: storeSet, get: storeGet, remove: storeDelete, keys: storeKeys, clear: storeClear }
};
