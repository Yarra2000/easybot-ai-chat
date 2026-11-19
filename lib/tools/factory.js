'use strict';

/**
 * 工具工厂。
 *
 * 把"外部声明式工具定义"翻译成可执行 handler。支持的回调类型:
 *
 *  1) 回调其它插件/服务的 HTTP 接口 (推荐, 任何语言写的插件都能对接)
 *     { "type": "http", "url": "http://127.0.0.1:18888/tool/xxx", "method": "POST", "headers": {...} }
 *     调用时会把工具参数作为 JSON 请求体 POST 过去, 响应文本/JSON 作为工具结果。
 *
 *  2) 调用服务器上的 EasyBot 扩展 (服务端插件/模组) 的 RPC 方法
 *     { "type": "bridge-rpc", "serverToken": "", "identifier": "bridge:test", "method": "get_date" }
 *
 *  3) 本地内置能力别名 (把已注册的某个工具再暴露一次, 一般用不到)
 *     { "type": "alias", "target": "eb_server_players" }
 */

const util = require('../util.js');
const config = require('../config.js');
const http = require('../httpclient.js');
const registry = require('./registry.js');
const builtin = require('./builtin.js');

/** 多台服务器时的提示文本 (与 builtin 一致) */
function serverNote(server) {
    return server && server.multiple
        ? ('（当前有 ' + server.allNames + ' 多台在线, 本次调用的是「' + server.name + '」）')
        : '';
}

/** 从回调响应里提取结果 */
function pickHttpResult(resp) {
    if (!resp) return null;
    if (resp.data !== undefined && resp.data !== null) return resp.data;
    const body = resp.body || '';
    const parsed = util.safeJson(body, undefined);
    return parsed === undefined ? body : parsed;
}

/** HTTP 回调 handler */
function buildHttpHandler(callback, def) {
    const url = util.trim(callback.url);
    if (!url) throw new Error('http 回调缺少 url');
    const method = String(callback.method || 'POST').toUpperCase();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, callback.headers || {});
    return async function (args, ctx) {
        const payload = {
            tool: def.name,
            arguments: args || {},
            context: ctx ? {
                sessionKey: ctx.sessionKey || '',
                senderId: ctx.senderId || '',
                senderName: ctx.senderName || '',
                peerId: ctx.peerId || '',
                kind: ctx.kind || ''
            } : {}
        };
        const resp = await http.request({
            url: url,
            method: method,
            headers: headers,
            body: method === 'GET' ? undefined : JSON.stringify(payload),
            timeoutMs: Number(config.get().tools.timeoutMs) || 15000
        });
        if (resp && resp.status >= 400) {
            throw new Error('工具接口返回 HTTP ' + resp.status + ': ' + util.truncate(resp.body || '', 200));
        }
        return pickHttpResult(resp);
    };
}

/** 服务端扩展 RPC handler */
function buildBridgeHandler(callback, def) {
    const identifier = util.trim(callback.identifier);
    const method = util.trim(callback.method);
    if (!identifier || !method) throw new Error('bridge-rpc 回调缺少 identifier 或 method');
    return async function (args) {
        // 复用 builtin 的服务器选择逻辑: 指定 token / 默认 token / 唯一在线 / 第一台
        const server = builtin.resolveServer(callback.serverToken);
        const merged = Object.assign({}, callback.args || {}, args || {});
        const result = await server.bridge.RpcInvoke(identifier, method, merged);
        const data = builtin.plain(result);
        if (server.multiple && data && typeof data === 'object') data.note = serverNote(server);
        return data;
    };
}

/** 别名 handler */
function buildAliasHandler(callback, def) {
    const target = util.trim(callback.target);
    if (!target) throw new Error('alias 回调缺少 target');
    return async function (args, ctx) {
        return registry.invoke(target, args || {}, ctx);
    };
}

/** 依据 callback 定义创建 handler */
function buildHandler(def) {
    const cb = def.callback || def.call || {};
    const type = util.trim(cb.type || 'http').toLowerCase();
    if (type === 'http') return buildHttpHandler(cb, def);
    if (type === 'bridge-rpc' || type === 'rpc-bridge' || type === 'bridge') return buildBridgeHandler(cb, def);
    if (type === 'alias') return buildAliasHandler(cb, def);
    throw new Error('未知的回调类型: ' + type);
}

/**
 * 批量注册一组声明式工具定义
 * @param {string} plugin 来源插件标识 (会成为工具名前缀)
 * @param {Array} defs    工具定义数组
 * @param {string} source 来源标记
 * @param {boolean} qualify 是否加前缀
 * @returns {{registered: string[], errors: string[]}}
 */
function registerDefs(plugin, defs, source, qualify) {
    const result = { registered: [], errors: [] };
    const list = util.toArray(defs);
    list.forEach(function (d, i) {
        try {
            if (!d || typeof d !== 'object') throw new Error('第 ' + (i + 1) + ' 项不是对象');
            if (!d.name) throw new Error('第 ' + (i + 1) + ' 项缺少 name');
            const handler = buildHandler(d);
            const name = registry.register({
                name: d.name,
                description: d.description || d.desc || '',
                parameters: util.safeJson(d.parameters, d.parameters) || { type: 'object', properties: {} },
                handler: handler,
                source: source,
                plugin: plugin,
                qualify: qualify === undefined ? true : !!qualify,
                meta: { callback: d.callback || d.call || null }
            });
            result.registered.push(name);
        } catch (e) {
            result.errors.push((d && d.name ? d.name + ': ' : '') + String((e && e.message) || e));
        }
    });
    return result;
}

module.exports = {
    buildHandler: buildHandler,
    registerDefs: registerDefs,
    pickHttpResult: pickHttpResult
};
