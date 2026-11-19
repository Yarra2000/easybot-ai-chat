'use strict';

/**
 * 自动发现其它插件的工具声明。
 *
 * 约定: 任何 EasyBot 插件只要在自己的插件目录里放一个 `ai-tools.json`
 *      (或在 manifest.json 里加一个 `ai_tools` 数组), 本插件就能自动把它的
 *      能力注册成大模型可调用的工具。
 *
 * ai-tools.json 示例:
 * {
 *   "tools": [
 *     {
 *       "name": "sign_in",
 *       "description": "给玩家签到",
 *       "parameters": {
 *         "type": "object",
 *         "properties": { "player": { "type": "string", "description": "玩家名" } },
 *         "required": ["player"]
 *       },
 *       "callback": { "type": "http", "url": "http://127.0.0.1:18888/tool/sign_in" }
 *     },
 *     {
 *       "name": "get_date",
 *       "description": "获取服务器时间",
 *       "parameters": { "type": "object", "properties": {} },
 *       "callback": { "type": "bridge-rpc", "identifier": "bridge:test", "method": "get_date" }
 *     }
 *   ]
 * }
 */

const util = require('../util.js');
const config = require('../config.js');
const registry = require('./registry.js');
const factory = require('./factory.js');

const TOOL_FILES = ['ai-tools.json', 'llm-tools.json', 'ai_tools.json'];
let _lastScan = { at: 0, dir: '', plugins: [], registered: [], errors: [] };

/** 探测 C# 标准库 System.IO (ClearScript 环境下可用) */
function io() {
    try {
        if (typeof System !== 'undefined' && System && System.IO &&
            System.IO.Directory && System.IO.File && System.IO.Path) {
            return System.IO;
        }
    } catch (e) { /* ignore */ }
    return null;
}

function joinPath(ioNs, a, b) {
    try { return ioNs.Path.Combine(a, b); } catch (e) { return String(a).replace(/[\\/]+$/, '') + '\\' + b; }
}

function readText(ioNs, path) {
    try {
        if (!ioNs.File.Exists(path)) return null;
        return String(ioNs.File.ReadAllText(path));
    } catch (e) {
        return null;
    }
}

/** 从 litedb 路径推断插件根目录候选 */
function candidateRoots() {
    const out = [];
    const cfg = config.get().tools.discover || {};
    if (cfg.pluginsDir) out.push(util.trim(cfg.pluginsDir));
    try {
        if (typeof litedb !== 'undefined' && litedb && typeof litedb.GetDbPath === 'function') {
            const dbPath = String(litedb.GetDbPath() || '');
            if (dbPath) {
                const ioNs = io();
                let dir;
                try { dir = ioNs ? ioNs.Path.GetDirectoryName(dbPath) : dbPath.replace(/[\\/][^\\/]*$/, ''); }
                catch (e) { dir = dbPath.replace(/[\\/][^\\/]*$/, ''); }
                if (dir) {
                    out.push(dir);                                        // {plugins}/{id}
                    out.push(dir.replace(/[\\/][^\\/]*$/, ''));           // {plugins}
                    out.push(dir.replace(/[\\/][^\\/]*[\\/]?[^\\/]*$/, '')); // 再上一层
                }
            }
        }
    } catch (e) { /* ignore */ }
    return out.filter(function (x, i, arr) { return x && arr.indexOf(x) === i; });
}

/** 判断目录里是否存在插件声明 */
function looksLikePluginDir(ioNs, dir) {
    try {
        if (ioNs.File.Exists(joinPath(ioNs, dir, 'manifest.json'))) return true;
    } catch (e) { /* ignore */ }
    return TOOL_FILES.some(function (f) {
        try { return ioNs.File.Exists(joinPath(ioNs, dir, f)); } catch (e) { return false; }
    });
}

/** 解析一个插件目录里的工具声明 */
function readDefsFromDir(ioNs, dir) {
    let tools = null;
    for (let i = 0; i < TOOL_FILES.length && !tools; i++) {
        const p = joinPath(ioNs, dir, TOOL_FILES[i]);
        const text = readText(ioNs, p);
        if (text) {
            const parsed = util.safeJson(text, null);
            if (parsed && Array.isArray(parsed.tools)) tools = parsed.tools;
            else if (Array.isArray(parsed)) tools = parsed;
        }
    }
    if (!tools) {
        const mf = readText(ioNs, joinPath(ioNs, dir, 'manifest.json'));
        if (mf) {
            const parsed = util.safeJson(mf, null);
            if (parsed && Array.isArray(parsed.ai_tools)) tools = parsed.ai_tools;
        }
    }
    return tools;
}

/** 读取插件目录的 plugin_id */
function readPluginId(ioNs, dir) {
    const mf = readText(ioNs, joinPath(ioNs, dir, 'manifest.json'));
    if (mf) {
        const parsed = util.safeJson(mf, null);
        if (parsed && parsed.plugin_id) return String(parsed.plugin_id);
    }
    try {
        const parts = String(dir).split(/[\\/]/).filter(Boolean);
        return parts[parts.length - 1] || 'unknown';
    } catch (e) { return 'unknown'; }
}

/**
 * 扫描并注册
 * @returns {{ok: boolean, reason?: string, plugins: string[], registered: string[], errors: string[], dir: string}}
 */
function scan() {
    const ioNs = io();
    const result = { ok: true, plugins: [], registered: [], errors: [], dir: '' };

    if (!(config.get().tools.discover || {}).enabled) {
        result.ok = false; result.reason = '未启用自动发现';
        return result;
    }
    if (!ioNs) {
        result.ok = false;
        result.reason = '当前环境无法访问文件系统 (System.IO 不可用), 请改用 HTTP 网关注册或手动配置 httpTools';
        _lastScan = { at: util.now(), dir: '', plugins: [], registered: [], errors: [] };
        return result;
    }

    const roots = candidateRoots();
    let root = null;
    let dirs = [];
    for (let i = 0; i < roots.length; i++) {
        try {
            const list = util.toArray(ioNs.Directory.GetDirectories(roots[i])).map(String);
            const hit = list.filter(function (d) { return looksLikePluginDir(ioNs, d); });
            if (hit.length) { root = roots[i]; dirs = list; break; }
        } catch (e) { /* 目录不存在, 继续尝试下一个候选 */ }
    }

    if (!root) {
        result.ok = false;
        result.reason = '没有找到插件目录 (可手动设置 tools.discover.pluginsDir)';
        return result;
    }
    result.dir = root;

    // 清理上一次发现的工具, 避免残留
    registry.list().filter(function (t) { return t.source === 'discover'; })
        .forEach(function (t) { registry.unregister(t.name); });

    dirs.forEach(function (dir) {
        if (!looksLikePluginDir(ioNs, dir)) return;
        const defs = readDefsFromDir(ioNs, dir);
        if (!defs || !defs.length) return;
        const pluginId = readPluginId(ioNs, dir);
        if (pluginId === 'easybot_ai_chat') return; // 跳过自己
        const r = factory.registerDefs(pluginId, defs, 'discover', true);
        if (r.registered.length || r.errors.length) {
            result.plugins.push(pluginId);
            result.registered = result.registered.concat(r.registered);
            result.errors = result.errors.concat(r.errors.map(function (e) { return pluginId + ' -> ' + e; }));
        }
    });

    _lastScan = {
        at: util.now(), dir: root,
        plugins: result.plugins, registered: result.registered, errors: result.errors
    };
    return result;
}

function lastScan() { return _lastScan; }

/** 加载配置里手工声明的 httpTools / bridgeTools */
function loadConfiguredTools() {
    const cfg = config.get().tools;
    const result = { registered: [], errors: [] };
    ['httpTools', 'bridgeTools'].forEach(function (key) {
        const defs = util.toArray(cfg[key]);
        if (!defs.length) return;
        const r = factory.registerDefs('cfg_' + key.replace('Tools', ''), defs, key === 'httpTools' ? 'config-http' : 'bridge-rpc', true);
        result.registered = result.registered.concat(r.registered);
        result.errors = result.errors.concat(r.errors);
    });
    return result;
}

module.exports = {
    scan: scan,
    lastScan: lastScan,
    loadConfiguredTools: loadConfiguredTools,
    systemIoAvailable: function () { return !!io(); }
};
