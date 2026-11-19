'use strict';

/**
 * DSH（DeepSeek Harness）接入。
 *
 * 架构：
 *   插件跑在 docker 容器里，DSH 在宿主机上 → 宿主机跑 dsh-bridge（见仓库里的 dsh-bridge 目录），
 *   本模块只做 HTTP 客户端 + 本地状态（模式开关、会话 id、待确认请求）。
 *
 * 两种模式：
 *   ① 工具模式：模型自己决定调用 dsh_run（→ 管理员确认 → 执行 → dsh_result 取结果）
 *   ② DSH 模式：某个用户进入该模式后，他发的消息【直接转发】给 DSH，不经过大模型
 *
 * 状态持久化：litedb，统一存 JSON 字符串（真机上存 JS 对象会静默写不进去 ✗）
 */

const util = require('./util.js');
const config = require('./config.js');
const httpclient = require('./httpclient.js');

// ---------------------------------------------------------------- 配置

const DEFAULTS = {
    enabled: false,
    baseUrl: '',
    token: '',
    cwd: '',
    timeoutMs: 200000,
    // 回给群里的"简要输出"长度
    maxReplyChars: 800,
    // 输出默认用合并转发（宿主支持时；不支持会自动回退成一条长文本 ✓）
    forwardAsMerge: true,
    // ① 谁能批准工具执行（权限等级）
    approveMinLevel: 3,
    // 确认等待时间
    approvalTimeoutSec: 180,
    // ② 谁能进入 DSH 模式
    modeMinLevel: 3,
    // DSH 模式空闲多久自动退出（秒，0=不自动退出）
    modeIdleTimeoutSec: 1800,
    // 输出形式：auto=能合并转发就合并、否则渲染成图片；merge=只用合并；image=只用图片；text=只用文本
    outputMode: 'auto',
    // ★ 图片输出（把长输出渲染成一张图发出去；背景图/字体都可配）
    image: {
        enabled: true,
        background: '',              // 背景图 URL 或本地路径；留空=纯色
        backgroundColor: '#17171c',
        width: 760,
        padding: 30,
        fontFamily: '"Microsoft YaHei","Noto Sans CJK SC","PingFang SC",sans-serif',
        fontSize: 22,
        lineHeight: 1.7,
        color: '#e9e9ee',
        titleColor: '#8ab4f8',
        titleSize: 26,
        maxCharsPerImage: 1500,      // 单张图最多多少字（超过就分页）
        maxImages: 3,                // 最多发几张
        timeoutSec: 30,
        template: '',                // 自定义 HTML 模板文件（插件目录下）；占位符 {{title}} {{content}} {{time}}
        uriMode: 'base64',           // base64 / data / file
    },
};

function settingsGet(key, def) {
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Get !== 'function') return def;
        const raw = litedb.Get('settings', key);
        if (raw === null || raw === undefined) return def;
        if (typeof raw === 'string') {
            const parsed = util.safeJson(raw, undefined);
            return parsed === undefined ? def : parsed;
        }
        return def;
    } catch (e) { return def; }
}

function settingsSet(key, value) {
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Set !== 'function') return false;
        return !!litedb.Set('settings', key, util.safeStringify(value));
    } catch (e) { return false; }
}

/** 生效配置：默认值 <- config.get().dsh <- litedb 里的 dsh_override */
function cfg() {
    const base = (config.get && config.get().dsh) || {};
    const ov = settingsGet('dsh_override', null) || {};
    const out = Object.assign({}, DEFAULTS, base, (ov && typeof ov === 'object') ? ov : {});
    out.baseUrl = String(out.baseUrl || '').replace(/\/+$/, '');
    out.token = String(out.token || '');
    out.cwd = String(out.cwd || '');
    out.timeoutMs = Math.max(10000, Number(out.timeoutMs) || DEFAULTS.timeoutMs);
    out.maxReplyChars = Math.max(120, Math.min(4000, Number(out.maxReplyChars) || DEFAULTS.maxReplyChars));
    out.approveMinLevel = Number(out.approveMinLevel);
    if (isNaN(out.approveMinLevel)) out.approveMinLevel = DEFAULTS.approveMinLevel;
    out.modeMinLevel = Number(out.modeMinLevel);
    if (isNaN(out.modeMinLevel)) out.modeMinLevel = DEFAULTS.modeMinLevel;
    out.approvalTimeoutSec = Math.max(30, Number(out.approvalTimeoutSec) || DEFAULTS.approvalTimeoutSec);
    out.modeIdleTimeoutSec = Math.max(0, Number(out.modeIdleTimeoutSec) || 0);
    out.outputMode = String(out.outputMode || 'auto').toLowerCase();
    if (['auto', 'merge', 'image', 'text'].indexOf(out.outputMode) < 0) out.outputMode = 'auto';

    // image 是嵌套对象：DEFAULTS <- config.get().dsh.image <- dsh_override.image 逐层覆盖 ✓
    const img = Object.assign({}, DEFAULTS.image,
        (base && typeof base.image === 'object' && base.image) ? base.image : {},
        (ov && typeof ov.image === 'object' && ov.image) ? ov.image : {});
    img.width = Math.max(320, Math.min(1600, Number(img.width) || 760));
    img.padding = Math.max(0, Math.min(120, Number(img.padding) || 30));
    img.fontSize = Math.max(10, Math.min(60, Number(img.fontSize) || 22));
    img.titleSize = Math.max(10, Math.min(80, Number(img.titleSize) || 26));
    img.lineHeight = Math.max(1, Math.min(3, Number(img.lineHeight) || 1.7));
    img.maxCharsPerImage = Math.max(200, Math.min(8000, Number(img.maxCharsPerImage) || 1500));
    img.maxImages = Math.max(1, Math.min(9, Number(img.maxImages) || 3));
    img.timeoutSec = Math.max(5, Math.min(120, Number(img.timeoutSec) || 30));
    img.enabled = img.enabled !== false;
    out.image = img;
    return out;
}

/** 保存一层的覆盖（供 !dsh set 用） */
function saveOverride(patch) {
    const cur = settingsGet('dsh_override', null) || {};
    const next = Object.assign({}, cur, patch || {});
    // image 是嵌套对象：别被浅合并冲掉之前的键 ✓
    if (patch && patch.image && typeof patch.image === 'object' && cur.image && typeof cur.image === 'object') {
        next.image = Object.assign({}, cur.image, patch.image);
    }
    const ok = settingsSet('dsh_override', next);
    if (ok) config.reload && config.reload();
    return ok;
}

function ready() {
    const c = cfg();
    return !!(c.enabled && c.baseUrl && c.token);
}

function notReadyReason() {
    const c = cfg();
    if (!c.enabled) return 'DSH 未启用（dsh.enabled=false）';
    if (!c.baseUrl) return 'DSH 未配置地址（dsh.baseUrl）';
    if (!c.token) return 'DSH 未配置令牌（dsh.token）';
    return '';
}

// ---------------------------------------------------------------- HTTP 客户端

function timeoutOf(extra) {
    return Math.max(10000, Number(extra) || cfg().timeoutMs);
}

async function health() {
    const c = cfg();
    if (!c.baseUrl) return { ok: false, error: '未配置 dsh.baseUrl' };
    try {
        const r = await httpclient.request({
            method: 'GET',
            url: c.baseUrl + '/health',
            timeoutMs: 8000,
            headers: { 'Accept': 'application/json' }
        });
        const data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        if (!data) return { ok: false, error: '健康检查返回异常: ' + String((r && r.body) || '').slice(0, 120) };
        return Object.assign({ ok: r.status === 200 }, data);
    } catch (e) {
        return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) };
    }
}

/**
 * 执行一次 DSH 任务。
 * @returns {{ok:boolean, text?:string, sessionId?:string, ms?:number, error?:string, truncated?:boolean}}
 */
async function run(opts) {
    opts = opts || {};
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    const prompt = String(opts.prompt || '').trim();
    if (!prompt) return { ok: false, error: '任务内容不能为空' };

    const body = { prompt: prompt, timeoutMs: timeoutOf(opts.timeoutMs) };
    if (opts.sessionId) body.sessionId = String(opts.sessionId);
    if (opts.cwd || c.cwd) body.cwd = String(opts.cwd || c.cwd);

    try {
        const r = await httpclient.request({
            method: 'POST',
            url: c.baseUrl + '/run',
            timeoutMs: timeoutOf(opts.timeoutMs) + 15000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-DSH-Token': c.token,
            },
            body: JSON.stringify(body),
        });
        let data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        if (!data) {
            return { ok: false, error: 'dsh-bridge 返回异常(HTTP ' + (r && r.status) + '): ' + String((r && r.body) || '').slice(0, 160) };
        }
        if (r && r.status === 401) return { ok: false, error: 'DSH 令牌无效（dsh.token）' };
        if (r && r.status === 403) return { ok: false, error: 'dsh-bridge 拒绝来源（allowSubnets）' };
        return data;
    } catch (e) {
        return { ok: false, error: '请求 dsh-bridge 失败: ' + ((e && e.message) || e) };
    }
}

/** 列工作区（DSH Web 界面左侧那些） */
async function workspaces() {
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    try {
        const r = await httpclient.request({
            method: 'GET',
            url: c.baseUrl + '/workspaces',
            timeoutMs: 12000,
            headers: { 'Accept': 'application/json', 'X-DSH-Token': c.token },
        });
        const data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        if (!data) return { ok: false, error: '桥接返回异常(HTTP ' + (r && r.status) + ')' };
        return data;
    } catch (e) { return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) }; }
}

/** 列会话（可按工作区过滤；不传=所有工作区） */
async function sessions(workspaceId, limit) {
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    try {
        let url = c.baseUrl + '/sessions?limit=' + encodeURIComponent(String(limit || 20));
        if (workspaceId) url += '&workspaceId=' + encodeURIComponent(String(workspaceId));
        const r = await httpclient.request({
            method: 'GET',
            url: url,
            timeoutMs: 15000,
            headers: { 'Accept': 'application/json', 'X-DSH-Token': c.token },
        });
        const data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        if (!data) return { ok: false, error: '桥接返回异常(HTTP ' + (r && r.status) + ')' };
        return data;
    } catch (e) { return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) }; }
}

/** 读某个会话的对话摘要（用于"上下文继承"；网页会话也能读 ✓） */
async function digest(sessionId, maxChars) {
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    if (!sessionId) return { ok: false, error: '缺少 sessionId' };
    try {
        const r = await httpclient.request({
            method: 'GET',
            url: c.baseUrl + '/sessions/' + encodeURIComponent(String(sessionId)) + '/digest?maxChars=' + encodeURIComponent(String(maxChars || 8000)),
            timeoutMs: 90000,
            headers: { 'Accept': 'application/json', 'X-DSH-Token': c.token },
        });
        const data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        if (!data) return { ok: false, error: '桥接返回异常(HTTP ' + (r && r.status) + ')' };
        return data;
    } catch (e) { return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) }; }
}

/** 重启 MC 服务器（走 MCSManager 面板 API，桥接侧转发） */
async function restartServer(server) {
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    try {
        const r = await httpclient.request({
            method: 'POST',
            url: c.baseUrl + '/server/restart',
            timeoutMs: 60000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-DSH-Token': c.token },
            body: JSON.stringify({ server: String(server || '') }),
        });
        const data = (r && r.data) || util.safeJson(String((r && r.body) || ''), null);
        return data || { ok: false, error: '桥接返回异常(HTTP ' + (r && r.status) + ')' };
    } catch (e) { return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) }; }
}

/** 新建工作区 */
async function createWorkspace(title, dir) {
    const c = cfg();
    if (!ready()) return { ok: false, error: notReadyReason() };
    try {
        const r = await httpclient.request({
            method: 'POST',
            url: c.baseUrl + '/workspace/create',
            timeoutMs: 12000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-DSH-Token': c.token },
            body: JSON.stringify({ title: String(title || ''), path: String(dir || '') }),
        });
        return (r && r.data) || util.safeJson(String((r && r.body) || ''), { ok: false, error: '返回异常' });
    } catch (e) { return { ok: false, error: '连不上 dsh-bridge: ' + ((e && e.message) || e) }; }
}

/** 把某个会话登记到工作区（= 在 DSH 界面里挂到那个工作区下） */
async function registerSession(workspaceId, sessionId) {
    const c = cfg();
    if (!ready() || !workspaceId || !sessionId) return { ok: false };
    try {
        const r = await httpclient.request({
            method: 'POST',
            url: c.baseUrl + '/workspace/register',
            timeoutMs: 12000,
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-DSH-Token': c.token },
            body: JSON.stringify({ workspaceId: String(workspaceId), sessionId: String(sessionId) }),
        });
        return (r && r.data) || { ok: false };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 每个用户选的工作区（按 QQ 存） */
function wsKey(uid) { return 'workspace:' + String(uid); }
function workspaceOf(uid) {
    const v = settingsGet(wsKey(uid), null);
    if (!v || typeof v !== 'object' || !v.id) return null;
    return v;
}
function setWorkspace(uid, ws) {
    if (!ws || !ws.id) return false;
    return settingsSet(wsKey(uid), { id: String(ws.id), title: String(ws.title || ''), path: String(ws.path || '') });
}
function clearWorkspace(uid) { return settingsSet(wsKey(uid), null); }

/** 把长输出压成"简要结果" */
function brief(text, maxChars) {
    const t = String(text === null || text === undefined ? '' : text).trim();
    const max = Math.max(80, Number(maxChars) || cfg().maxReplyChars);
    if (t.length <= max) return t;
    return t.slice(0, max) + '\n…（输出较长，已截断；完整 ' + t.length + ' 字）';
}

// ---------------------------------------------------------------- ② 模式状态（按用户）

function modeKey(uid) { return 'mode:' + String(uid); }
function sessKey(uid) { return 'session:' + String(uid); }

function modeState(uid) {
    const v = settingsGet(modeKey(uid), null);
    if (!v || typeof v !== 'object') return null;
    return v;
}

function isModeOn(uid) {
    const st = modeState(uid);
    if (!st || !st.on) return false;
    const idle = Number(cfg().modeIdleTimeoutSec) || 0;
    if (idle > 0 && st.at && (Date.now() - Number(st.at)) > idle * 1000) {
        setMode(uid, false);
        return false;
    }
    return true;
}

function touchMode(uid) {
    const st = modeState(uid) || { on: true };
    st.at = Date.now();
    settingsSet(modeKey(uid), st);
}

function setMode(uid, on) {
    settingsSet(modeKey(uid), { on: !!on, at: Date.now() });
}

function modeSession(uid) { return String(settingsGet(sessKey(uid), '') || ''); }
function setModeSession(uid, sid) { settingsSet(sessKey(uid), String(sid || '')); }
function resetModeSession(uid) { settingsSet(sessKey(uid), ''); }

/** 谁当前处于 DSH 模式（用于日志/状态展示） */
function enabledUsers() {
    const out = [];
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Get !== 'function') return out;
    } catch (e) { return out; }
    return out;
}

// ---------------------------------------------------------------- ① 待确认请求

const pendings = new Map();     // code -> request
let _seq = 0;
let _notifier = null;           // 由 chat.js 注入：往"当前会话"发消息

function setNotifier(fn) { _notifier = fn || null; }

/** 取当前这一轮的「往会话发消息」函数（存到请求里，别用全局的，否则并发会串会话 ✗） */
function currentNotifier() { return _notifier; }

async function notify(text) {
    if (!_notifier) return false;
    try { await _notifier(String(text)); return true; } catch (e) { return false; }
}

function makeCode() {
    const n = (++_seq) % 1000;
    const s = Math.random().toString(36).slice(2, 6).toUpperCase();
    return 'D' + String(n).padStart(2, '0') + s;
}

/**
 * 建一个待确认请求。
 * @param {{userId:string, name?:string, task:string, notify?:Function}} opts
 */
function createPending(opts) {
    const code = makeCode();
    const req = {
        code: code,
        id: 'dsh-' + Date.now().toString(36) + '-' + code,
        userId: String(opts.userId || ''),
        name: String(opts.name || ''),
        task: String(opts.task || ''),
        kind: String(opts.kind || 'dsh'),
        server: String(opts.server || ''),
        status: 'pending',          // pending | running | done | rejected | error | timeout
        text: '',
        error: '',
        createdAt: Date.now(),
        notify: opts.notify || _notifier || null,
    };
    pendings.set(code, req);
    // 清理过期的
    const ttl = Math.max(60, Number(cfg().approvalTimeoutSec) || 180) * 1000;
    const now = Date.now();
    for (const [k, v] of pendings) {
        if (now - v.createdAt > ttl + 600000) pendings.delete(k);
    }
    return req;
}

function getPending(code) {
    if (!code) return null;
    const key = String(code).toUpperCase();
    return pendings.get(key) || pendings.get(String(code)) || null;
}

/** 按 code 或 requestId 找请求 */
function findPending(key) {
    if (!key) return null;
    const k = String(key).trim();
    const up = k.toUpperCase();
    if (pendings.has(up)) return pendings.get(up);
    for (const req of pendings.values()) {
        if (req.id === k || req.code === up) return req;
    }
    return null;
}

function pendingOfUser(uid) {
    const out = [];
    for (const req of pendings.values()) {
        if (String(req.userId) === String(uid) && req.status === 'pending') out.push(req);
    }
    return out;
}

function listPendings() {
    const out = [];
    for (const req of pendings.values()) {
        if (req.status === 'pending' || req.status === 'running') out.push(req);
    }
    return out;
}

function setPendingStatus(code, status, extra) {
    const req = getPending(code);
    if (!req) return null;
    req.status = status;
    if (extra && extra.text !== undefined) req.text = extra.text;
    if (extra && extra.error !== undefined) req.error = extra.error;
    return req;
}

function dropPending(code) {
    const req = getPending(code);
    if (req) pendings.delete(req.code);
}

module.exports = {
    DEFAULTS: DEFAULTS,
    cfg: cfg,
    saveOverride: saveOverride,
    ready: ready,
    notReadyReason: notReadyReason,
    health: health,
    run: run,
    workspaces: workspaces,
    sessions: sessions,
    restartServer: restartServer,
    digest: digest,
    createWorkspace: createWorkspace,
    registerSession: registerSession,
    workspaceOf: workspaceOf,
    setWorkspace: setWorkspace,
    clearWorkspace: clearWorkspace,
    brief: brief,

    isModeOn: isModeOn,
    touchMode: touchMode,
    setMode: setMode,
    modeSession: modeSession,
    setModeSession: setModeSession,
    resetModeSession: resetModeSession,
    enabledUsers: enabledUsers,

    setNotifier: setNotifier,
    currentNotifier: currentNotifier,
    notify: notify,
    createPending: createPending,
    getPending: getPending,
    findPending: findPending,
    pendingOfUser: pendingOfUser,
    listPendings: listPendings,
    setPendingStatus: setPendingStatus,
    dropPending: dropPending,
};
