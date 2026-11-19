'use strict';

/**
 * 工具注册中心。
 *
 * 所有能被大模型调用的"工具"都注册到这里, 无论它来自:
 *   - 本插件内置工具 (builtin)
 *   - 其它 EasyBot 插件通过 HTTP 工具网关注册 (http)
 *   - 其它 EasyBot 插件在自己的插件目录放 ai-tools.json 被自动发现 (discover)
 *   - 配置文件里声明的 HTTP / 服务端扩展 RPC 工具 (config-http / bridge-rpc)
 *   - 服务端扩展通过 RPC 主动注册 (rpc)
 */

const util = require('../util.js');
const config = require('../config.js');

/** name -> definition */
const _tools = new Map();

/** 默认参数模板 */
function emptySchema() {
    return { type: 'object', properties: {}, required: [] };
}

/** 规范化/校验参数 schema */
function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object') return emptySchema();
    const out = {
        type: 'object',
        properties: (schema.properties && typeof schema.properties === 'object') ? schema.properties : {},
        required: Array.isArray(schema.required) ? schema.required.map(String) : []
    };
    if (schema.description) out.description = String(schema.description);
    if (schema.additionalProperties !== undefined) out.additionalProperties = schema.additionalProperties;
    return out;
}

/**
 * 注册一个工具
 * @param {object} def
 * @param {string} def.name          工具名 (可被自动加前缀)
 * @param {string} def.description   给模型看的说明
 * @param {object} def.parameters    JSON Schema
 * @param {Function} def.handler     async (args, ctx) => any
 * @param {string} def.source        builtin | http | discover | config-http | bridge-rpc | rpc
 * @param {string} def.plugin        来源插件 / 标识
 * @param {boolean} def.qualify      是否给名字加 "plugin__" 前缀 (默认 true, 当 plugin 存在时)
 * @returns {string} 最终注册的工具名
 */
function register(def) {
    if (!def || typeof def !== 'object') throw new Error('工具定义必须是对象');
    let base = util.sanitizeToolName(def.name);
    const plugin = def.plugin ? util.sanitizeToolName(def.plugin) : '';
    const qualify = def.qualify === undefined ? true : !!def.qualify;
    const name = (qualify && plugin && base.indexOf(plugin + '__') !== 0)
        ? util.sanitizeToolName(plugin + '__' + base)
        : base;

    if (typeof def.handler !== 'function') throw new Error('工具 ' + name + ' 缺少 handler');

    _tools.set(name, {
        name: name,
        baseName: base,
        description: util.truncate(def.description || ('工具 ' + base), 1000),
        parameters: normalizeSchema(def.parameters),
        handler: def.handler,
        source: def.source || 'unknown',
        plugin: plugin || 'builtin',
        meta: def.meta || {},
        registeredAt: util.now()
    });
    return name;
}

/** 移除工具 */
function unregister(name) {
    return _tools.delete(util.sanitizeToolName(name));
}

/** 按来源插件批量移除 */
function unregisterByPlugin(plugin) {
    const p = util.sanitizeToolName(plugin);
    let removed = 0;
    Array.from(_tools.keys()).forEach(function (k) {
        if (_tools.get(k).plugin === p) { _tools.delete(k); removed++; }
    });
    return removed;
}

function get(name) {
    return _tools.get(name) || null;
}

function list() {
    return Array.from(_tools.values());
}

function clear() {
    _tools.clear();
}

/** 转成 OpenAI tools 定义 */
function toOpenAITools() {
    const out = [];
    _tools.forEach(function (t) {
        out.push({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters
            }
        });
    });
    return out;
}

/** 供人阅读的工具清单文本 */
function describeText() {
    const items = list();
    if (!items.length) return '当前没有可用工具。';
    return items.map(function (t) {
        return '- ' + t.name + ' [' + t.source + '] ' + util.truncate(t.description, 80);
    }).join('\n');
}

/**
 * 调用一个工具
 * @param {string} name
 * @param {object} args
 * @param {object} [context] 运行上下文(会话键/发送者等), 会与工具自身信息合并后传给 handler
 * @returns {Promise<any>}
 */
async function invoke(name, args, context) {
    const t = get(name);
    if (!t) throw new Error('工具不存在: ' + name);
    const timeoutMs = Number(config.get().tools.timeoutMs) || 15000;
    const ctx = Object.assign({ name: name, plugin: t.plugin }, context || {});
    const result = await util.withTimeout(Promise.resolve(t.handler(args || {}, ctx)), timeoutMs, '工具' + name);
    return result;
}

module.exports = {
    register: register,
    unregister: unregister,
    unregisterByPlugin: unregisterByPlugin,
    get: get,
    list: list,
    clear: clear,
    toOpenAITools: toOpenAITools,
    describeText: describeText,
    invoke: invoke
};
