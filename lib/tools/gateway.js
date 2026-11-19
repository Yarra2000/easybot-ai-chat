'use strict';

/**
 * 工具网关 (HTTP 服务端)。
 *
 * 这是"让大模型调用 EasyBot 其它插件"最通用的一条通道:
 * 任何插件(甚至外部程序)都可以通过 HTTP 把能力注册进来, 之后大模型就能调用它。
 *
 * 接口:
 *   GET  /health          健康检查
 *   GET  /tools           查看当前所有工具
 *   POST /register        注册工具  { plugin, token?, tools: [ {name, description, parameters, callback} ] }
 *   POST /unregister      注销工具  { plugin, token? }
 *   POST /invoke          反向调用  { name, arguments, callbackUrl? }
 *
 * 注册示例(由"另一个插件"执行):
 *   network.post("http://127.0.0.1:20777/register", JSON.stringify({
 *     plugin: "my_plugin",
 *     tools: [{
 *       name: "sign_in",
 *       description: "给玩家签到",
 *       parameters: { type: "object", properties: { player: { type: "string" } }, required: ["player"] },
 *       callback: { type: "http", url: "http://127.0.0.1:18888/tool/sign_in" }
 *     }]
 *   }));
 */

const util = require('../util.js');
const config = require('../config.js');
const registry = require('./registry.js');
const factory = require('./factory.js');

let _serverId = null;
let _started = false;

/** /invoke 的异步结果缓存: requestId -> {status, result|error} */
const _results = {};
const RESULT_TTL_MS = 5 * 60 * 1000;

/** 清理过期的调用结果 */
function purgeResults() {
    const deadline = util.now() - RESULT_TTL_MS;
    Object.keys(_results).forEach(function (k) {
        if (_results[k] && _results[k].at < deadline) delete _results[k];
    });
}

/** 解析 url 里的查询串 (req.url 可能是 '/path?a=b' 或完整 URL) */
function parseQuery(url) {
    const out = {};
    try {
        const s = String(url || '');
        const i = s.indexOf('?');
        if (i < 0) return out;
        s.slice(i + 1).split('&').forEach(function (kv) {
            if (!kv) return;
            const j = kv.indexOf('=');
            const k = j < 0 ? kv : kv.slice(0, j);
            const v = j < 0 ? '' : kv.slice(j + 1);
            try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
            catch (e) { out[k] = v; }
        });
    } catch (e) { /* ignore */ }
    return out;
}

/** 读取请求头 (兼容 HeaderCollection) */
function getHeader(req, name) {
    try {
        const h = req && req.headers;
        if (!h) return '';
        if (typeof h.Get === 'function') {
            const v = h.Get(name);
            if (v) return String(v);
        }
        if (h[name] !== undefined) return String(h[name]);
        if (typeof h.GetKeys === 'function') {
            const keys = util.toArray(h.GetKeys());
            for (let i = 0; i < keys.length; i++) {
                if (String(keys[i]).toLowerCase() === String(name).toLowerCase()) {
                    const v = typeof h.Get === 'function' ? h.Get(keys[i]) : h[keys[i]];
                    return v === undefined || v === null ? '' : String(v);
                }
            }
        }
    } catch (e) { /* ignore */ }
    return '';
}

/** 统一写响应 */
function write(res, status, obj) {
    try {
        res.status = status;
        res.body = typeof obj === 'string' ? obj : JSON.stringify(obj);
        if (res.headers && typeof res.headers.Set === 'function') {
            res.headers.Set('Content-Type', 'application/json; charset=utf-8');
        }
    } catch (e) { /* ignore */ }
    return res;
}

/** 读取请求体 JSON */
function bodyJson(req) {
    const raw = req && req.body ? String(req.body) : '';
    const parsed = util.safeJson(raw, null);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

/** 校验令牌 (未配置令牌时不校验) */
function authOk(req, bodyObj) {
    const token = util.trim(config.get().tools.gateway.token);
    if (!token) return true;
    const fromHeader = getHeader(req, 'x-ai-tool-token');
    const fromQuery = getHeader(req, 'authorization');
    const fromBody = bodyObj && bodyObj.token ? String(bodyObj.token) : '';
    return fromHeader === token || fromBody === token || fromQuery === 'Bearer ' + token;
}

function configSnapshot() {
    const t = config.get().tools;
    return { tools: registry.list().length, gatewayPort: t.gateway.port, enabled: t.enabled };
}

/** 启动网关 */
async function start() {
    const cfg = config.get().tools;
    if (!cfg.gateway || !cfg.gateway.enabled) {
        logger.info('[ai-chat] 工具网关未启用');
        return false;
    }
    // 幂等: 已经启动过就直接返回, 避免热重载/重复 enable 时重复建服务
    if (_started && _serverId) return true;
    if (typeof httpServer === 'undefined' || !httpServer || typeof httpServer.CreateServer !== 'function') {
        logger.warning('[ai-chat] 当前 EasyBot 版本不支持 httpServer API, 工具网关不可用');
        return false;
    }

    let host = util.trim(cfg.gateway.host) || '127.0.0.1';
    if (!cfg.gateway.allowRemote && host !== '127.0.0.1' && host !== 'localhost') {
        logger.warning('[ai-chat] 出于安全考虑, 工具网关只监听 127.0.0.1 (如需外网访问请开启 allowRemote)');
        host = '127.0.0.1';
    }
    const port = util.clamp(cfg.gateway.port, 1024, 65535);

    try {
        _serverId = httpServer.CreateServer(port, 'ai_chat_gateway', host);
    } catch (e) {
        logger.error('[ai-chat] 创建工具网关失败: {0}', (e && e.message) || e);
        return false;
    }

    // ---------------- 路由 ----------------
    httpServer.OnGet(_serverId, '/health', function (req, res) {
        return write(res, 200, {
            ok: true,
            plugin: 'easybot_ai_chat',
            version: '1.0.0',
            tools: registry.list().length,
            time: util.formatTime()
        });
    });

    httpServer.OnGet(_serverId, '/tools', function (req, res) {
        if (!authOk(req, null)) return write(res, 401, { ok: false, error: '无效的令牌' });
        return write(res, 200, {
            ok: true,
            tools: registry.list().map(function (t) {
                return {
                    name: t.name, description: t.description, parameters: t.parameters,
                    source: t.source, plugin: t.plugin
                };
            })
        });
    });

    httpServer.OnPost(_serverId, '/register', function (req, res) {
        const body = bodyJson(req);
        if (!authOk(req, body)) return write(res, 401, { ok: false, error: '无效的令牌' });
        const plugin = util.trim(body.plugin) || 'external';
        const defs = body.tools || body.tool || [];
        try {
            registry.unregisterByPlugin(plugin);
            const result = factory.registerDefs(plugin, defs, body.source || 'http', true);
            if (result.registered.length) {
                logger.info('[ai-chat] 插件 {0} 注册了 {1} 个工具: {2}',
                    plugin, result.registered.length, result.registered.join(', '));
            }
            if (result.errors.length) {
                logger.warning('[ai-chat] 插件 {0} 部分工具注册失败: {1}', plugin, result.errors.join(' | '));
            }
            return write(res, 200, { ok: true, plugin: plugin, registered: result.registered, errors: result.errors });
        } catch (e) {
            return write(res, 400, { ok: false, error: String((e && e.message) || e) });
        }
    });

    httpServer.OnPost(_serverId, '/unregister', function (req, res) {
        const body = bodyJson(req);
        if (!authOk(req, body)) return write(res, 401, { ok: false, error: '无效的令牌' });
        const plugin = util.trim(body.plugin);
        if (!plugin) return write(res, 400, { ok: false, error: '缺少 plugin' });
        const removed = registry.unregisterByPlugin(plugin);
        return write(res, 200, { ok: true, removed: removed });
    });

    // 工具调用是异步的, 而 EasyBot 的 HTTP handler 不会被 await
    // (实测: handler 里 await 之后写的 res 会得到空响应体),
    // 所以 /invoke 一律同步返回 202 + requestId, 结果通过
    // callbackUrl 回调 或 GET /result?requestId= 轮询获取。
    httpServer.OnPost(_serverId, '/invoke', function (req, res) {
        const body = bodyJson(req);
        if (!authOk(req, body)) return write(res, 401, { ok: false, error: '无效的令牌' });
        const name = util.trim(body.name);
        const args = body.arguments || body.args || {};
        const callbackUrl = util.trim(body.callbackUrl);
        // 允许调用方指定"以谁的身份"执行(用于测试权限/其它插件代调用)
        const ctxOverride = (body.context && typeof body.context === 'object') ? body.context : null;
        if (!name) return write(res, 400, { ok: false, error: '缺少 name' });
        if (!registry.get(name)) return write(res, 404, { ok: false, error: '工具不存在: ' + name });

        const requestId = 'req_' + util.shortId();
        _results[requestId] = { status: 'running', at: util.now(), name: name };
        purgeResults();

        // 关键: 先把响应同步写完, 再异步执行工具
        write(res, 202, {
            ok: true,
            accepted: true,
            requestId: requestId,
            name: name,
            pollUrl: '/result?requestId=' + requestId,
            note: '工具调用是异步的: 请轮询 pollUrl, 或注册时提供 callbackUrl'
        });

        Promise.resolve()
            .then(function () { return registry.invoke(name, args, ctxOverride); })
            .then(function (result) {
                const text = typeof result === 'string' ? result : util.safeStringify(result);
                _results[requestId] = { status: 'done', at: util.now(), name: name, result: text };
                if (callbackUrl) {
                    return network.post(callbackUrl, JSON.stringify({
                        requestId: requestId, ok: true, name: name, result: text
                    }));
                }
            })
            .catch(function (e) {
                const msg = String((e && e.message) || e);
                _results[requestId] = { status: 'error', at: util.now(), name: name, error: msg };
                if (callbackUrl) {
                    try {
                        return network.post(callbackUrl, JSON.stringify({
                            requestId: requestId, ok: false, name: name, error: msg
                        }));
                    } catch (x) { /* ignore */ }
                }
            });
        return res;
    });

    // 端到端提问: 自然语言 -> 模型(可调工具) -> 回复
    // 用 senderId/senderRole 指定"以谁的身份"提问, 指令权限校验会按这个身份走。
    // 端到端提问: 自然语言 -> 模型(可调工具) -> 回复
    // 用 senderId/senderRole 指定"以谁的身份"提问, 指令权限校验会按这个身份走。
    // 注意: httpServer 的 handler 不会被 await, 大模型又要几十秒, 所以这里同样是
    //       202 + requestId 的异步契约, 结果用 GET /result?requestId=... 轮询。
    httpServer.OnPost(_serverId, '/chat', function (req, res) {
        const body = bodyJson(req);
        if (!authOk(req, body)) return write(res, 401, { ok: false, error: '无效的令牌' });
        const prompt = util.trim(body.prompt || body.message || '');
        if (!prompt) return write(res, 400, { ok: false, error: '缺少 prompt' });

        const senderId = util.trim(body.senderId) || 'gateway';
        const requestId = 'chat_' + Math.random().toString(36).slice(2, 8);
        _results[requestId] = { status: 'running', name: 'chat', startedAt: util.now() };
        write(res, 202, {
            ok: true, accepted: true, requestId: requestId,
            pollUrl: '/result?requestId=' + requestId,
            note: '对话是异步的: 请轮询 pollUrl 取回复'
        });

        // 后台执行, 不阻塞响应
        Promise.resolve()
            .then(function () {
                const chat = require('../chat.js');
                return chat.askOnce(prompt, {
                    senderId: senderId,
                    senderName: util.trim(body.senderName) || senderId,
                    senderRole: util.trim(body.senderRole) || '',
                    peerId: util.trim(body.peerId) || senderId,
                    kind: body.kind === 'group' ? 'group' : 'direct',
                    scene: '这是通过 HTTP 网关发起的一次性提问, 请正常回复。'
                });
            })
            .then(function (r) {
                _results[requestId] = {
                    status: 'done', name: 'chat', finishedAt: util.now(),
                    result: {
                        reply: r.content,
                        toolCalls: (r.toolCalls || []).map(function (t) { return t.name || t; }),
                        senderId: senderId
                    }
                };
            })
            .catch(function (e) {
                _results[requestId] = { status: 'error', name: 'chat', error: String((e && e.message) || e) };
            });
        return res;
    });

    httpServer.OnGet(_serverId, '/result', function (req, res) {
        if (!authOk(req, null)) return write(res, 401, { ok: false, error: '无效的令牌' });
        const q = parseQuery(req && req.url);
        // 也允许从请求头里带 requestId
        const requestId = util.trim(q.requestId || getHeader(req, 'x-request-id'));
        if (!requestId) return write(res, 400, { ok: false, error: '缺少 requestId' });
        const rec = _results[requestId];
        if (!rec) return write(res, 404, { ok: false, error: '未知的 requestId (可能已过期)' });
        if (rec.status === 'running') return write(res, 202, { ok: true, status: 'running', name: rec.name });
        if (rec.status === 'done') return write(res, 200, { ok: true, status: 'done', name: rec.name, result: rec.result });
        return write(res, 200, { ok: false, status: 'error', name: rec.name, error: rec.error });
    });

    // ---------------- 启动 ----------------
    try {
        _started = await httpServer.StartServerAsync(_serverId);
        if (_started) {
            logger.info('[ai-chat] 工具网关已启动: http://{0}:{1}  (其它插件可 POST /register 注册工具)', host, port);
        } else {
            logger.error('[ai-chat] 工具网关启动失败 (端口 {0} 可能被占用)', port);
        }
    } catch (e) {
        _started = false;
        logger.error('[ai-chat] 工具网关启动异常: {0}', (e && e.message) || e);
    }
    return _started;
}

/** 停止网关 */
async function stop() {
    if (!_serverId) return true;
    try {
        if (_started && httpServer.StopServerAsync) await httpServer.StopServerAsync(_serverId);
        if (httpServer.DestroyServerAsync) await httpServer.DestroyServerAsync(_serverId);
        _started = false;
        _serverId = null;
        return true;
    } catch (e) {
        logger.warning('[ai-chat] 停止工具网关出错: {0}', (e && e.message) || e);
        return false;
    }
}

/** 重启网关 (改端口后使用) */
async function restart() {
    await stop();
    return start();
}

function status() {
    return {
        serverId: _serverId,
        running: _started,
        address: (_serverId && typeof httpServer !== 'undefined' && httpServer.GetServerAddress)
            ? (function () { try { return httpServer.GetServerAddress(_serverId); } catch (e) { return ''; } })()
            : ''
    };
}

module.exports = {
    start: start,
    stop: stop,
    restart: restart,
    status: status,
    getHeader: getHeader
};
