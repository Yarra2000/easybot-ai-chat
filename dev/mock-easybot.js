'use strict';

/**
 * 离线自测用的 EasyBot 运行时模拟器。
 *
 * 它把插件会用到的全局对象 (logger / bus / config / litedb / network / sessions /
 * httpServer / form / rpc / menu / MessageChain 等) 都实现成最小可用版本,
 * 这样就能在 Node 里直接 require("../main.js") 跑通整个流程, 而不用真的启动 EasyBot。
 *
 * 仅供开发调试使用, 打包发布时可以删掉整个 dev/ 目录。
 */

const path = require('path');

// ---------------------------------------------------------------- 日志

const logs = [];
function makeLogger(level) {
    return function (message) {
        const args = Array.prototype.slice.call(arguments, 1);
        let text = String(message);
        args.forEach(function (a, i) { text = text.replace('{' + i + '}', String(a)); });
        logs.push({ level: level, text: text });
    };
}

const logger = { info: makeLogger('info'), warning: makeLogger('warn'), error: makeLogger('error') };

// ---------------------------------------------------------------- 事件总线

const handlers = {};
const bus = {
    on: function (event, handler) {
        handlers[event] = handlers[event] || [];
        handlers[event].push(handler);
    },
    emit: async function (event) {
        const args = Array.prototype.slice.call(arguments, 1);
        const list = handlers[event] || [];
        const results = [];
        for (let i = 0; i < list.length; i++) {
            results.push(await list[i].apply(null, args));
        }
        return results;
    },
    count: function (event) { return (handlers[event] || []).length; }
};

// ---------------------------------------------------------------- 配置

const configValues = {};   // groupId -> object
const config = {
    getConfig: function (g) { return configValues[g] ? JSON.stringify(configValues[g]) : null; },
    getConfigObject: function (g) { return configValues[g] || null; },
    getAllConfigs: function () { return configValues; },
    hasConfig: function (g) { return !!configValues[g]; },
    getConfigValue: function (g, p, d) { return d; },
    getString: function (g, p, d) { return d; },
    getNumber: function (g, p, d) { return d; },
    getInt: function (g, p, d) { return d; },
    getBoolean: function (g, p, d) { return d; },
    getArray: function () { return []; }
};

// ---------------------------------------------------------------- LiteDB

const liteStore = {};
const litedb = {
    GetDbPath: function () { return path.resolve(__dirname, '../../plugins/easybot_ai_chat/easybot_ai_chat.ldb'); },
    Set: function (c, k, v) { (liteStore[c] = liteStore[c] || {})[k] = JSON.parse(JSON.stringify(v)); return true; },
    Get: function (c, k) { const b = liteStore[c]; return b && k in b ? JSON.parse(JSON.stringify(b[k])) : null; },
    GetValue: function (c, k, d) { const v = litedb.Get(c, k); return v === null ? d : v; },
    GetString: function (c, k, d) { const v = litedb.Get(c, k); return v === null ? d : String(v); },
    GetNumber: function (c, k, d) { const v = litedb.Get(c, k); return v === null ? d : Number(v); },
    GetBoolean: function (c, k, d) { const v = litedb.Get(c, k); return v === null ? d : !!v; },
    GetDateTime: function () { return new Date(); },
    Delete: function (c, k) { if (liteStore[c]) delete liteStore[c][k]; return true; },
    Exists: function (c, k) { return !!(liteStore[c] && k in liteStore[c]); },
    GetKeys: function (c) { return Object.keys(liteStore[c] || {}); },
    Count: function (c) { return Object.keys(liteStore[c] || {}).length; },
    Clear: function (c) { liteStore[c] = {}; return true; },
    Increment: function (c, k, i) { const v = (litedb.GetNumber(c, k, 0) + (i || 1)); litedb.Set(c, k, v); return v; },
    GetCollections: function () { return Object.keys(liteStore); },
    DropCollection: function (c) { delete liteStore[c]; return true; },
    RenameCollection: function () { return true; },
    Backup: function () { return true; },
    Shrink: function () { return true; },
    GetFileSize: function () { return 0; },
    ExportToJson: function () { return '{}'; },
    ImportFromJson: function () { return 0; },
    Query: function () { return []; },
    BatchSet: function () { return 0; },
    BatchGet: function () { return {}; },
    BatchDelete: function () { return 0; }
};

// ---------------------------------------------------------------- HTTP 客户端

const networkCalls = [];
let networkResponder = function () { return { status: 200, body: '{}', data: {} }; };
const network = {
    request: async function (message) {
        networkCalls.push(message);
        const r = await networkResponder(message, networkCalls.length);
        return {
            status: r.status === undefined ? 200 : r.status,
            headers: {},
            body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body || r.data || {}),
            data: r.data !== undefined ? r.data : (typeof r.body === 'object' ? r.body : JSON.parse(r.body || '{}'))
        };
    },
    get: function (url) { return network.request({ url: url, method: 'GET', headers: {} }); },
    post: function (url, body) { return network.request({ url: url, method: 'POST', headers: {}, body: body }); },
    put: function (url, body) { return network.request({ url: url, method: 'PUT', headers: {}, body: body }); },
    del: function (url) { return network.request({ url: url, method: 'DELETE', headers: {} }); },
    head: function (url) { return network.request({ url: url, method: 'HEAD', headers: {} }); },
    options: function (url) { return network.request({ url: url, method: 'OPTIONS', headers: {} }); }
};

// ---------------------------------------------------------------- 服务器会话

const serverActions = [];
function makeBridge(name, token) {
    return {
        Session: { Info: { CachedServerName: name, CachedServerToken: token, CachedServerDescription: '测试服', CachedPluginVersion: '1.0.0' } },
        GetServerInfo: async function () { return { ServerName: name, ServerVersion: 'Paper 1.20.4', IsPapiSupported: true }; },
        GetPlayerListAsync: async function () {
            return { Success: true, Message: '', List: [{ PlayerName: 'Steve', PlayerUuid: 'u1', Bedrock: false }, { PlayerName: 'Alex', PlayerUuid: 'u2', Bedrock: true }] };
        },
        SendRunCommandAsync: async function (playerName, command, enablePapi) {
            serverActions.push({ type: 'command', playerName: playerName, command: command, enablePapi: enablePapi });
            if (/^list\b/.test(command)) {
                return { Success: true, Text: 'There are 2 of a max of 20 players online: Steve, Alex' };
            }
            return { Success: true, Text: '已执行: ' + command };
        },
        SendMessageToAllPlayer: function (text) { serverActions.push({ type: 'broadcast', text: text }); },
        SendPlaceholderApiQueryAsync: async function (player, text) { return { Result: '%player_level% -> 42' }; },
        RpcInvoke: async function (identifier, method, args) {
            serverActions.push({ type: 'rpc', identifier: identifier, method: method, args: args });
            return { date: 1700000000000, identifier: identifier, method: method, args: args };
        },
        GetExtensions: async function () { return { Extensions: { 'bridge:test': { Identifier: 'bridge:test' } } }; }
    };
}
/** 模拟真实环境的 .NET List: 只有 Count + ToArray(), 没有 get()/length */
function dotnetListOf(items) {
    return {
        Count: items.length,
        ToArray: function () { return items.slice(); }
    };
}

// 第二台服务器: 玩家列表用 .NET 集合表示 (复现真机上踩过的坑)
function makeDotnetBridge(name, token) {
    const b = makeBridge(name, token);
    b.GetPlayerListAsync = async function () {
        return {
            Success: true,
            Message: '',
            List: dotnetListOf([
                { PlayerName: 'PlayerF', PlayerUuid: 'uuid-1', PlayerIp: '/1.2.3.4:1', Bedrock: false }
            ])
        };
    };
    return b;
}

const _bridges = [makeBridge('生存服', 'token-1'), makeDotnetBridge('真机风格服', 'token-2')];
const sessions = {
    IsAlive: function () { return true; },
    ServerExists: function (t) { return _bridges.some(function (b) { return b.Session.Info.CachedServerToken === t; }); },
    Remove: function () { },
    GetBridge: function (x) {
        if (typeof x === 'string') return _bridges.filter(function (b) { return b.Session.Info.CachedServerToken === x; })[0] || null;
        return _bridges[0];
    },
    GetSessions: function () { return _bridges.map(function (b) { return b.Session; }); },
    GetBridges: function () { return _bridges; }
};

// ---------------------------------------------------------------- HTTP 服务端

const httpRoutes = {};
const httpServers = {};
const httpServer = {
    CreateServer: function (port, id, host) {
        const sid = id || ('srv_' + Object.keys(httpServers).length);
        httpServers[sid] = { port: port, host: host || '127.0.0.1', running: false };
        httpRoutes[sid] = {};
        return sid;
    },
    StartServerAsync: async function (id) { if (httpServers[id]) httpServers[id].running = true; return true; },
    StopServerAsync: async function (id) { if (httpServers[id]) httpServers[id].running = false; return true; },
    DestroyServerAsync: async function (id) { delete httpServers[id]; return true; },
    OnGet: function (id, p, h) { (httpRoutes[id] = httpRoutes[id] || {})['GET ' + p] = h; return true; },
    OnPost: function (id, p, h) { (httpRoutes[id] = httpRoutes[id] || {})['POST ' + p] = h; return true; },
    OnPut: function (id, p, h) { (httpRoutes[id] = httpRoutes[id] || {})['PUT ' + p] = h; return true; },
    OnDelete: function (id, p, h) { (httpRoutes[id] = httpRoutes[id] || {})['DELETE ' + p] = h; return true; },
    OnRequest: function (id, m, p, h) { (httpRoutes[id] = httpRoutes[id] || {})[m + ' ' + p] = h; return true; },
    OffRequest: function (id, m, p) { delete (httpRoutes[id] || {})[m + ' ' + p]; return true; },
    IsServerRunning: function (id) { return !!(httpServers[id] && httpServers[id].running); },
    GetServerAddress: function (id) { return httpServers[id] ? (httpServers[id].host + ':' + httpServers[id].port) : ''; },
    GetServerIds: function () { return Object.keys(httpServers); }
};

/** 测试用: 直接调用某个已注册的路由 */
async function callRoute(serverId, method, p, req) {
    const h = (httpRoutes[serverId] || {})[method + ' ' + p];
    if (!h) throw new Error('路由不存在: ' + method + ' ' + p);
    const res = { status: 0, body: '', headers: { Set: function () { } } };
    const ret = await h(req || { url: p, method: method, headers: {}, body: '' }, res);
    return ret && ret.status !== undefined ? ret : res;
}

// ---------------------------------------------------------------- database(绑定关系)

const socialAccounts = {};
const database = {
    GetSocialAccount: function (platform, uuid) {
        return socialAccounts[platform + '|' + uuid] || null;
    },
    GetPlayers: function () { return []; },
    BindPlayerToSocialAccount: function () { return true; }
};
/** 测试用: 设置 QQ -> MC 玩家 绑定 */
function bindSocial(platform, uuid, players) {
    socialAccounts[platform + '|' + uuid] = {
        Platform: platform, Uuid: String(uuid),
        Users: (players || []).map(function (n) { return { Name: n }; })
    };
    return true;
}

// ---------------------------------------------------------------- 消息模型

class Segment { AsString() { return ''; } }
class TextSegment extends Segment { constructor(t) { super(); this.Text = String(t); } AsString() { return this.Text; } }
class AtSegment extends Segment { constructor(id) { super(); this.Id = String(id); } AsString() { return '@' + this.Id; } }
class ImageSegment extends Segment { constructor(uri) { super(); this.Uri = uri; } AsString() { return '[图片]'; } }
class FaceSegment extends Segment { constructor(id) { super(); this.id = String(id); } AsString() { return '[' + this.id + ']'; } }
class ReplySegment extends Segment { constructor(id) { super(); this.Id = String(id); } AsString() { return '[回复' + this.Id + ']'; } }
class MessageChain {
    constructor() { this._s = []; }
    get Count() { return this._s.length; }
    get IsReadOnly() { return false; }
    get(i) { return this._s[i]; }
    Add(s) { this._s.push(s); return this; }
    Text() { for (let i = 0; i < arguments.length; i++) this._s.push(new TextSegment(arguments[i])); return this; }
    NextLine() { return this.Text('\n'); }
    At(id) { this._s.push(new AtSegment(id)); return this; }
    Image(uri) { this._s.push(new ImageSegment(uri)); return this; }
    Face(id) { this._s.push(new FaceSegment(id)); return this; }
    Reply(id) { this._s.push(new ReplySegment(id)); return this; }
    // 模拟真实 SDK: Node(id, name, userId, chain) 把内层消息链作为转发节点
    Node(id, name, userId, chain) {
        const inner = (chain && typeof chain.AsString === 'function') ? String(chain.AsString()) : '';
        this._s.push({ AsString: function () { return inner; } });
        return this;
    }
    AsArray() { return this._s.slice(); }
    AsString() { return this._s.map(function (s) { try { return s.AsString(); } catch (e) { return ''; } }).join(''); }
}

// ---------------------------------------------------------------- 动态表单

function component(kind, id, title, description, configure) {
    const c = {
        type: kind, id: id, title: title, description: description || '',
        visible: true, children: [], options: [],
        addChild: function (x) { c.children.push(x); return c; },
        addOption: function (v, l) { c.options.push({ value: v, label: l }); return c; },
        defaultValue: undefined, placeholder: '', isPassword: false, min: 0, max: 0, step: 1,
        trueLabel: '', falseLabel: ''
    };
    if (typeof configure === 'function') configure(form, c);
    return c;
}
const formDefinitions = [];
const form = {
    ComponentType: { InputString: 0, InputNumber: 1, Toggle: 2, ContainerGroup: 3, RepeaterList: 4 },
    createFormData: function (title, id, svg) { return { title: title, id: id, svg: svg }; },
    createForm: function (title, formData, description, configure) {
        const def = { title: title, formData: formData, description: description, root: component('group', 'root', title) };
        if (typeof configure === 'function') configure(form, def.root);
        formDefinitions.push(def);
        return def;
    },
    createStringInput: function (id, title, d, c) { return component('string', id, title, d, c); },
    createNumberInput: function (id, title, d, c) { return component('number', id, title, d, c); },
    createToggle: function (id, title, d, c) { return component('toggle', id, title, d, c); },
    createContainerGroup: function (id, title, d, c) { return component('group', id, title, d, c); },
    createRepeater: function (id, title, cid, d, c) { return component('repeater', id, title, d, c); },
    createSelect: function (id, title, d, c) { return component('select', id, title, d, c); }
};

// ---------------------------------------------------------------- 其它

const rpcHandlers = {};
const rpc = {
    on: function (method, handler) { rpcHandlers[method] = handler; },
    withError: function (m) { return { error: true, message: m }; }
};

const menu = { get: function () { return null; }, getAll: function () { return []; }, getChildren: function () { return []; }, exists: function () { return false; } };

const archive = {
    supportReadFile: function () { return false; },
    readString: function () { return null; },
    readStringAsync: async function () { return null; },
    readBytes: function () { return null; },
    readBytesAsync: async function () { return null; },
    getFiles: function () { return []; },
    getDirectories: function () { return []; }
};

const threading = {
    setTimeout: setTimeout, setInterval: setInterval,
    clearTimeout: clearTimeout, clearInterval: clearInterval,
    createMutex: function () { return { WaitOne: function () { return true; }, ReleaseMutex: function () { } }; }
};

/** 模拟一个可用的机器人适配器 (用于测试主动发消息) */
const sentViaAdapter = [];
const fakeAdapter = {
    PlatformName: 'qq',
    AdapterName: 'OneBot11',
    InstanceId: 'MockAdapter-1',
    DisplayName: '模拟适配器',
    GetProfile: function () { return { Id: '99999', Name: '小助手', IsActive: true }; },
    GetAdapterContext: function () {
        return {
            SendGroupMessageAsync: async function (selfId, groupId, chain) {
                sentViaAdapter.push({ kind: 'group', selfId: String(selfId), peerId: String(groupId), text: chain.AsString() });
                return 'msgid_' + sentViaAdapter.length;
            },
            SendDirectMessageAsync: async function (selfId, userId, chain) {
                sentViaAdapter.push({ kind: 'direct', selfId: String(selfId), peerId: String(userId), text: chain.AsString() });
                return 'msgid_' + sentViaAdapter.length;
            }
        };
    }
};
const framework = {
    GetAdapter: function () { return fakeAdapter; },
    GetAdapterById: function () { return fakeAdapter; },
    GetAdapters: function () { return [fakeAdapter]; }
};

// ---------------------------------------------------------------- 安装到全局

/** 安装所有模拟对象到 Node 全局 (插件代码里用的是裸标识符) */
function install() {
    const g = global;
    g.logger = logger;
    g.bus = bus;
    g.config = config;
    g.litedb = litedb;
    g.network = network;
    g.sessions = sessions;
    g.httpServer = httpServer;
    g.form = form;
    g.rpc = rpc;
    g.menu = menu;
    g.archive = archive;
    g.threading = threading;
    g.framework = framework;
    g.db = database;            // 真机命名空间是 db
    g.database = database;      // 兼容
    g.Segment = Segment;
    g.TextSegment = TextSegment;
    g.AtSegment = AtSegment;
    g.ImageSegment = ImageSegment;
    g.FaceSegment = FaceSegment;
    g.ReplySegment = ReplySegment;
    g.MessageChain = MessageChain;
    return g;
}

module.exports = {
    install: install,
    logger: logger, logs: logs,
    bus: bus, handlers: handlers,
    config: config, configValues: configValues,
    litedb: litedb, liteStore: liteStore,
    network: network, networkCalls: networkCalls,
    database: database,
    bindSocial: bindSocial,
    setNetworkResponder: function (fn) { networkResponder = fn; },
    sessions: sessions, bridges: _bridges, serverActions: serverActions,
    dotnetListOf: dotnetListOf,
    httpServer: httpServer, httpRoutes: httpRoutes, httpServers: httpServers, callRoute: callRoute,
    form: form, formDefinitions: formDefinitions,
    rpc: rpc, rpcHandlers: rpcHandlers,
    menu: menu, archive: archive,
    sentViaAdapter: sentViaAdapter, fakeAdapter: fakeAdapter,
    Segment: Segment, TextSegment: TextSegment, AtSegment: AtSegment, ImageSegment: ImageSegment,
    FaceSegment: FaceSegment, ReplySegment: ReplySegment, MessageChain: MessageChain,
    reset: function () {
        Object.keys(handlers).forEach(function (k) { delete handlers[k]; });
        Object.keys(rpcHandlers).forEach(function (k) { delete rpcHandlers[k]; });
        logs.length = 0;
        networkCalls.length = 0;
        serverActions.length = 0;
    }
};
