/**
 * AI 对话助手 (easybot_ai_chat) —— EasyBot 插件: 拟人化大模型对话与工具调用
 * Copyright (C) 2026 Yarra2000
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * 本程序是自由软件: 你可以依据 GNU Affero 通用公共许可证(AGPL)第 3 版
 * (或你选择的任何更新版本)的条款, 重新发布和/或修改它。
 * 本程序按"现状"发布, 不含任何担保; 详细条款见随附的 LICENSE 文件。
 */

/// <reference path="easybot-sdk/easybot.d.ts" />

'use strict';

/**
 * EasyBot AI 对话助手 (仿 MaiBot 的拟人化大模型对话)
 * ---------------------------------------------------------------
 * 功能:
 *   - 群聊/私聊的大模型对话, 有人设、短期上下文、长期记忆
 *   - 群聊里"听得到"但不乱插话: @我 / 叫名字 / 关键词 / 回复我 / 连续对话 才会开口
 *   - 拟人化: 打字延迟、把长回复拆成多条、随机引用与表情、冷却与频率限制
 *   - 工具调用: 内置服务器工具 + 其它 EasyBot 插件注册的工具 + 服务端扩展 RPC
 *   - WebUI 管理面板: 状态 / 工具 / 记忆 / 人设 / 对话测试
 *
 * 入口文件只做"接线", 具体实现在 lib/ 下。
 */

const util = require('./lib/util.js');
const config = require('./lib/config.js');
const memory = require('./lib/memory.js');
const llm = require('./lib/llm.js');
const http = require('./lib/httpclient.js');
const registry = require('./lib/tools/registry.js');
const builtin = require('./lib/tools/builtin.js');
const ruleTools = require('./lib/tools/rules.js');
const discover = require('./lib/tools/discover.js');
const gateway = require('./lib/tools/gateway.js');
const factory = require('./lib/tools/factory.js');
const chat = require('./lib/chat.js');
const webui = require('./lib/webui.js');

const PLUGIN_ID = 'easybot_ai_chat';
// ★ 改版本号时请同时改 manifest.json 的 version(保持一致)
const VERSION = '1.8.3';

let _enabled = false;
let _builtinRegistered = false;
let _gcTimer = null;

/** 安全执行, 避免异常冒泡到宿主 */
function safe(label, fn) {
    return function () {
        try {
            const r = fn.apply(null, arguments);
            if (r && typeof r.then === 'function') {
                return r.catch(function (e) {
                    logger.error('[ai-chat] {0} 出错: {1}', label, (e && e.message) || e);
                });
            }
            return r;
        } catch (e) {
            logger.error('[ai-chat] {0} 出错: {1}', label, (e && e.message) || e);
        }
    };
}

/** 初始化工具 */
function initTools() {
    if (!_builtinRegistered) {
        builtin.registerAll();
        ruleTools.registerAll();      // 把配置里的"意图->指令"规则注册成独立工具
        _builtinRegistered = true;
    }
    // 配置里手工声明的工具
    try {
        const r = discover.loadConfiguredTools();
        if (r.registered.length) logger.info('[ai-chat] 已从配置加载 {0} 个工具', r.registered.length);
        if (r.errors.length) logger.warning('[ai-chat] 配置工具错误: {0}', r.errors.join(' | '));
    } catch (e) {
        logger.warning('[ai-chat] 加载配置工具失败: {0}', (e && e.message) || e);
    }
    // 自动扫描其它插件的 ai-tools.json
    try {
        const r = discover.scan();
        if (r.ok && r.registered.length) {
            logger.info('[ai-chat] 自动发现 {0} 个其它插件的工具: {1}', r.plugins.length, r.registered.join(', '));
        } else if (!r.ok && r.reason) {
            logger.info('[ai-chat] 未自动发现外部工具: {0}', r.reason);
        }
    } catch (e) {
        logger.warning('[ai-chat] 扫描其它插件工具失败: {0}', (e && e.message) || e);
    }
}

// ---------------------------------------------------------------- 自检

/** 打印某个宿主命名空间的可疑成员, 便于适配不同 EasyBot build */
function dumpMembers(label, obj) {
    if (!obj) { logger.info('[ai-chat] {0}: 不存在', label); return; }
    let keys = [];
    try { keys = Object.keys(obj); } catch (e) {
        logger.info('[ai-chat] {0}: 无法枚举成员', label);
        return;
    }
    const interesting = keys.filter(function (k) {
        return /^(request|Request|send|Send|get|Get|post|Post|put|Put|del|Del|delete|Delete|head|Head|options|Options|create|Create|reg|Reg|on|On|Set|Get|Add)/.test(k);
    });
    logger.info('[ai-chat] {0}: 共 {1} 个成员; 关注: {2}', label, keys.length, util.truncate(interesting.join(','), 500));
}

/** 探测 network 的可用方法与调用风格 (只做类型探测, 不发请求) */
async function probeNetwork() {
    if (typeof network === 'undefined' || !network) { logger.warning('[ai-chat] network 不存在, 无法发 HTTP 请求'); return; }
    const names = ['request', 'Request', 'get', 'post', 'put', 'del', 'head', 'options', 'Get', 'Post'];
    const types = names.map(function (n) {
        let t = 'n/a';
        try { t = typeof network[n]; } catch (e) { t = 'ERR'; }
        return n + '=' + t;
    }).filter(function (x) { return x.indexOf('=undefined') < 0; });
    logger.info('[ai-chat] network 可用成员: {0}', types.join(' '));
    logger.info('[ai-chat] HTTP 适配层: {0}', http.describe());
    logger.info('[ai-chat] 自定义请求头支持情况: {0}', http.supportsHeaders() === null
        ? '未知(尚未发起请求, 会在首次调用后给出结论)'
        : (http.supportsHeaders() ? '支持' : '不支持 (可用 llm.authMode=query/none 绕过)'));

    // .NET 桥 (ClearScript)
    const globals = { dotnet: typeof dotnet, System: typeof System, CS: typeof CS, importNamespace: typeof importNamespace };
    const found = Object.keys(globals).filter(function (k) { return globals[k] !== 'undefined'; });
    logger.info('[ai-chat] 其它运行时入口: {0}', found.length ? found.map(function (k) { return k + '=' + globals[k]; }).join(' ') : '(无)');
}

/** litedb 读写往返 + 内存状态诊断 (真实环境排错用) */
async function diagStorage() {
    const out = {};
    try {
        litedb.Set('__diag', 's', 'hello-字符串');
        const v = litedb.Get('__diag', 's');
        out.stringWrite = (v === null || v === undefined) ? 'null(没写进去)' : (typeof v + ':' + util.truncate(String(v), 40));
    } catch (e) { out.stringErr = String((e && e.message) || e); }
    try {
        litedb.Set('__diag', 'n', 12345);
        const v = litedb.Get('__diag', 'n');
        out.numberWrite = (v === null || v === undefined) ? 'null(没写进去)' : (typeof v + ':' + String(v));
    } catch (e) { out.numberErr = String((e && e.message) || e); }
    try {
        litedb.Set('__diag', 'o', JSON.stringify({ a: 1, b: '中文' }));
        const v = litedb.Get('__diag', 'o');
        out.jsonWrite = (v === null || v === undefined) ? 'null(没写进去)' : (typeof v + ':' + util.truncate(String(v), 50));
    } catch (e) { out.jsonErr = String((e && e.message) || e); }
    try { out.keys = util.toArray(litedb.GetKeys('__diag')).join(','); } catch (e) { out.keysErr = String((e && e.message) || e); }
    try {
        out.memStats = JSON.stringify(memory.stats());
        out.ctx363 = memory.getContext('g:123456789').messages.length;
    } catch (e) { out.memErr = String((e && e.message) || e); }
    try { out.dbPath = String(litedb.GetDbPath()); } catch (e) { }
    logger.info('[ai-chat] 存储诊断: {0}', JSON.stringify(out));
}

/** 桥接数据包结构诊断 (延迟执行, 等服务器连上) */
async function diagBridges() {
    try {
        const bridges = util.toArray(sessions.GetBridges());
        logger.info('[ai-chat] 桥接诊断: 在线服务器 {0} 台', bridges.length);
        if (!bridges.length) return;
        const b = bridges[0];
        const name = (b.Session && b.Session.Info && b.Session.Info.CachedServerName) || '?';
        const packet = await b.GetPlayerListAsync();

        let keysTail = [];
        try { keysTail = Object.keys(packet).slice(-12); } catch (e) { }
        const list = packet && packet.List;
        let listKeys = [];
        try { listKeys = list ? Object.keys(list).slice(-8) : []; } catch (e) { }
        const arr = util.toArray(list);
        let firstInfo = null;
        if (arr.length) {
            const el = arr[0];
            let elKeys = [];
            try { elKeys = Object.keys(el).slice(-10); } catch (e) { }
            firstInfo = {
                keys: elKeys,
                PlayerName: (function () { try { return String(el.PlayerName); } catch (e) { return 'ERR'; } })(),
                plain: JSON.stringify(builtin.plain(el)).substring(0, 160)
            };
        }

        logger.info('[ai-chat] 玩家列表包: server={0} Success={1} Message={2}', name,
            (function () { try { return String(packet.Success); } catch (e) { return 'ERR'; } })(),
            (function () { try { return JSON.stringify(packet.Message); } catch (e) { return 'ERR'; } })());
        logger.info('[ai-chat]   packet keys(尾)={0}', JSON.stringify(keysTail));
        logger.info('[ai-chat]   typeof List={0} List.Count={1} List.length={2} toArray={3}',
            typeof list,
            (function () { try { return String(list.Count); } catch (e) { return 'n/a'; } })(),
            (function () { try { return String(list.length); } catch (e) { return 'n/a'; } })(),
            arr.length);
        logger.info('[ai-chat]   List keys(尾)={0}', JSON.stringify(listKeys));
        if (firstInfo) logger.info('[ai-chat]   第一个玩家: {0}', JSON.stringify(firstInfo));
    } catch (e) {
        logger.warning('[ai-chat] 桥接诊断失败: {0}', (e && e.message) || e);
    }
}

/**
 * 大模型连通性自检 (由 llm.selfTestOnEnable 开启)。
 * 会真实调用一次模型, 用于确认接口地址 / 密钥 / 工具调用链路是否正常。
 */
async function selfTest() {
    // 第零步: 运行环境 API 诊断 (帮助适配不同版本)
    if (typeof network !== 'undefined') dumpMembers('network', network);
    if (typeof httpClient !== 'undefined') dumpMembers('httpClient', httpClient);
    if (typeof litedb !== 'undefined') dumpMembers('litedb', litedb);
    if (typeof httpServer !== 'undefined') dumpMembers('httpServer', httpServer);
    if (typeof form !== 'undefined') dumpMembers('form', form);
    if (typeof rpc !== 'undefined') dumpMembers('rpc', rpc);
    if (typeof menu !== 'undefined') dumpMembers('menu', menu);
    await probeNetwork();

    // 第一步: 发送链路自检 (只构建消息链, 不发送任何消息)
    try {
        const chain = new MessageChain()
            .Text('自检')
            .At('10000')
            .Text(' 你好')
            .NextLine()
            .Image('https://example.com/x.png')
            .Face(1);
        logger.info('[ai-chat] 消息链构建自检通过: Count={0} AsString={1}',
            chain.Count, util.truncate(String(chain.AsString()), 80));
    } catch (e) {
        logger.error('[ai-chat] 消息链构建自检失败: {0}', (e && e.message) || e);
    }

    const _auth = config.llm().authMode || 'header';
    if (_auth !== 'none' && !config.llm().apiKey) {
        logger.warning('[ai-chat] 大模型自检跳过: 尚未配置 API Key (authMode={0})', _auth);
        return;
    }
    logger.info('[ai-chat] 开始大模型自检 (会真实调用一次接口)...');
    const t0 = util.now();
    try {
        const prompt = util.trim(config.llm().selfTestPrompt) || '你好，请用一句话介绍你自己';
        logger.info('[ai-chat] 自检提问: {0}', util.truncate(prompt, 80));
        const r = await chat.askOnce(prompt, { senderName: '自检' });
        logger.info('[ai-chat] 自检成功, 耗时 {0}ms', util.now() - t0);
        logger.info('[ai-chat] 模型回复: {0}', util.truncate(r.content, 300));
        if (r.toolCalls && r.toolCalls.length) {
            logger.info('[ai-chat] 自检期间调用了 {0} 个工具: {1}',
                r.toolCalls.length, r.toolCalls.map(function (t) { return t.name; }).join(', '));
        } else {
            logger.info('[ai-chat] 自检期间未调用工具 (模型选择直接回答)');
        }
    } catch (e) {
        logger.error('[ai-chat] 自检失败 ({0}ms): {1}', util.now() - t0, (e && e.message) || e);
    } finally {
        // 视觉自检: 配了测试图片就真发一张图给模型看看它认不认得。
        // 注意: 图片是让**模型服务端**去抓的, 所以"抓图超时"是上游/CDN 的偶发问题,
        // 不代表插件坏了 —— 因此这里会重试若干次, 并把结论说清楚。
        const vcfg = config.get().vision || {};
        // 支持配多张候选图片(逗号/换行分隔), 逐个试, 提高自检成功率
        const testImgs = config.toList(vcfg.selfTestImageUrl).map(function (x) { return util.trim(x); }).filter(Boolean);
        if (vcfg.enabled && testImgs.length) {
            const rounds = Math.max(1, Number(vcfg.selfTestRounds) || 2);
            let done = false;
            let lastImgErr = '';
            for (let r = 0; r < rounds && !done; r++) {
                for (let k = 0; k < testImgs.length && !done; k++) {
                    const testImg = testImgs[k];
                    try {
                        const vr = await llm.chatOnce({
                            messages: [
                                { role: 'system', content: '你是图像描述助手，只描述你看到的画面。' },
                                {
                                    role: 'user', content: [
                                        { type: 'text', text: '这张图里是什么？一句话概括' },
                                        { type: 'image_url', image_url: { url: testImg } }
                                    ]
                                }
                            ],
                            maxTokens: 150
                        });
                        logger.info('[ai-chat] 视觉自检成功 (第{0}轮/第{1}张): {2}',
                            r + 1, k + 1, util.truncate(vr.content, 200));
                        done = true;
                    } catch (e) {
                        const msg = String((e && e.message) || e);
                        const isImg = /loading IMAGE|IMAGE data|Timed out while downloading media|Invalid image|image_url/i.test(msg);
                        if (isImg) {
                            lastImgErr = msg;
                            logger.warning('[ai-chat] 视觉自检第{0}轮第{1}张: 图片抓取失败(上游/CDN 偶发), 将重试: {2}',
                                r + 1, k + 1, util.truncate(msg, 120));
                            await util.sleep(1200 + k * 600);
                        } else {
                            logger.error('[ai-chat] 视觉自检失败(非图片抓取问题): {0}', msg);
                            done = true;   // 不是抓图问题, 重试无意义
                        }
                    }
                }
            }
            if (!done) {
                logger.warning('[ai-chat] 视觉自检未能完成: 试了 {0} 轮 x {1} 张图片, 都是图片抓取失败 —— ' +
                    '这是模型服务端下载图片超时(CDN 偶发), **不是插件或配置问题**; ' +
                    '可以稍后重启再看, 或把 vision.selfTestImageUrl 换成一个更稳定的图片地址',
                    rounds, testImgs.length);
            }
        }

        const nat = http.nativeAvailable ? http.nativeAvailable() : false;
        logger.info('[ai-chat] 原生 .NET HTTP: {0}{1}', nat ? '可用 (请求头完全可控, 无需转发)' : '不可用',
            nat ? '' : (' —— 原因: ' + ((http.nativeInfo && http.nativeInfo().err) || '(未知)')));
        const sup = http.supportsHeaders();
        logger.info('[ai-chat] HTTP 实测结论: 写法={0} 能否带自定义请求头={1}',
            http.workingStyle() || '(未调用)', sup === null ? '未知' : (sup ? '能' : '不能'));
    }
}

// ---------------------------------------------------------------- 生命周期

bus.on('enable', safe('enable', function () {
    _enabled = true;
    config.reload();
    logger.info('=====================================');
    logger.info(' AI 对话助手 v{0} 已启用', VERSION);
    // ★ 消息链诊断: 决定"能不能把 Wiki / MC百科 的图片直接发到群里"
    //   MessageChain 上有哪些方法、有没有 Image/ImageSegment 类型 —— 实测一次, 记在日志里
    try {
        const proto = (typeof MessageChain === 'function' && MessageChain.prototype) ? MessageChain.prototype : null;
        const methods = proto ? Object.getOwnPropertyNames(proto) : [];
        logger.info(' 消息链诊断: MessageChain={0} 方法=[{1}] | Image={2} ImageSegment={3}',
            typeof MessageChain, methods.join(','), typeof Image, typeof ImageSegment);
    } catch (e) { }
    const cfg = config.get();
    logger.info(' 模型: {0} @ {1}', cfg.llm.model, cfg.llm.baseUrl);
    const _authMode = cfg.llm.authMode || 'header';
    if (_authMode === 'none') {
        logger.info(' 鉴权: none (不需要 API Key, 由转发/本地服务负责)');
    } else if (!cfg.llm.apiKey) {
        logger.warning(' 尚未配置 API Key, 请在插件配置页填写 (llm.apiKey)');
    } else {
        logger.info(' 鉴权: {0} (API Key 已配置)', _authMode);
    }
    logger.info(' 群聊触发: {0} | 私聊回复: {1} | 冷却: {2}s | 每分钟上限: {3}',
        cfg.behavior.groupMode, cfg.behavior.replyToDirect, cfg.behavior.cooldownSec, cfg.behavior.maxRepliesPerMinute);
    logger.info(' 工具调用: {0} | 允许执行命令: {1} | 命令黑名单: {2} 条',
        cfg.tools.enabled ? '开启' : '关闭', cfg.tools.allowRunCommand, (cfg.tools.commandBlacklist || []).length);
    logger.info(' 屏蔽群: {0} | 允许群: {1} | 屏蔽私聊: {2}',
        (cfg.access.denyGroupIds || []).join(',') || '(无)',
        (cfg.access.allowGroupIds || []).join(',') || '(全部)',
        (cfg.access.denyDirectUserIds || []).join(',') || '(无)');
    logger.info('=====================================');

    // 注册配置表单 (动态表单)
    config.registerForm();

    // 工具
    initTools();

    // 工具网关
    safe('启动工具网关', function () { return gateway.start(); })();

    // 可选: 启用时做一次大模型连通性自检 (验证接口地址/密钥/工具调用链路)
    if (config.llm().selfTestOnEnable) {
        safe('大模型自检', function () { return selfTest(); })();
        // 服务器通常在启动后几秒才连上, 所以延迟再诊断一次
        if (typeof setTimeout === 'function') {
            setTimeout(function () { safe('桥接诊断', function () { return diagBridges(); })(); }, 20000);
            setTimeout(function () { safe('存储诊断', function () { return diagStorage(); })(); }, 30000);
        }
    }

    // 定期清理过期上下文
    if (!_gcTimer) {
        const tick = function () {
            try {
                const removed = memory.gc();
                if (removed) logger.info('[ai-chat] 已清理 {0} 个过期会话上下文', removed);
            } catch (e) { /* ignore */ }
        };
        _gcTimer = (typeof setInterval === 'function') ? setInterval(tick, 30 * 60 * 1000) : null;
    }
}));

bus.on('disable', safe('disable', function () {
    _enabled = false;
    if (_gcTimer !== null && typeof clearInterval === 'function') {
        try { clearInterval(_gcTimer); } catch (e) { /* ignore */ }
    }
    _gcTimer = null;
    chat.resetRuntime();
    return gateway.stop().then(function () {
        logger.info('[ai-chat] AI 对话助手已禁用');
    });
}));

// ---------------------------------------------------------------- 菜单

bus.on('menu_ready', safe('menu_ready', function (pluginMenu) {
    webui.register(pluginMenu);
}));

// ---------------------------------------------------------------- 配置变更

bus.on('config_changed', safe('config_changed', function (data) {
    const groupId = data && data.groupId;
    if (groupId && groupId !== 'main') return;
    config.reload();
    // 指令规则可能被改了, 重新注册(否则旧规则工具会残留)
    try { ruleTools.registerAll(); } catch (e) { /* ignore */ }
    logger.info('[ai-chat] 配置已重新载入 ({0})', (data && data.changeType) || 'changed');
}));

// ---------------------------------------------------------------- 消息事件

bus.on('group_message_event', function (event) {
    if (!_enabled) return;
    // 刻意不返回 Promise: 大模型请求可能持续几十秒, 不能阻塞 EasyBot 的事件管线
    Promise.resolve()
        .then(function () { return chat.onGroupMessage(event); })
        .catch(function (e) { logger.error('[ai-chat] 群消息处理失败: {0}', (e && e.message) || e); });
});

bus.on('direct_message_event', function (event) {
    if (!_enabled) return;
    Promise.resolve()
        .then(function () { return chat.onDirectMessage(event); })
        .catch(function (e) { logger.error('[ai-chat] 私聊处理失败: {0}', (e && e.message) || e); });
});

// ---------------------------------------------------------------- RPC 接口
// 服务端扩展(服务器上的 EasyBot 插件/模组) 可以调用这些接口, 也可以用它注册工具。

try {
    if (typeof rpc !== 'undefined' && rpc && typeof rpc.on === 'function') {
        rpc.on('register_tool', safe('rpc.register_tool', function (ctx) {
            const args = (ctx && ctx.args) || {};
            const plugin = util.trim(args.plugin) || 'server_extension';
            const tools = args.tools || args.tool || [];
            const r = factory.registerDefs(plugin, tools, 'rpc', true);
            return { ok: true, registered: r.registered, errors: r.errors, total: registry.list().length };
        }), '注册 AI 工具', '把服务端扩展的能力注册成 AI 可调用的工具');

        rpc.on('chat', safe('rpc.chat', async function (ctx) {
            const args = (ctx && ctx.args) || {};
            const prompt = util.trim(args.prompt || args.message || '');
            if (!prompt) return rpc.withError('缺少 prompt');
            const r = await chat.askOnce(prompt, {
                senderName: args.senderName || '服务端扩展',
                senderId: args.senderId || 'server',
                senderRole: args.senderRole || '',
                scene: '这是通过 RPC 调用的一次性提问, 请正常回复。'
            });
            return { content: r.content, tools: (r.toolCalls || []).map(function (t) { return t.name; }) };
        }), '对话', '让 AI 处理一段文本并返回回复');

        rpc.on('status', safe('rpc.status', function () {
            return chat.status();
        }), '状态', '获取 AI 对话助手运行状态');
    }
} catch (e) {
    logger.warning('[ai-chat] 注册 RPC 接口失败: {0}', (e && e.message) || e);
}

// ---------------------------------------------------------------- 载入提示

// ★ 启动时把 DSH 接入状态打出来（便于排查"为什么 !dsh 没反应"）
try {
    const _dsh = require('./lib/dsh.js');
    const _c = _dsh.cfg();
    let _merge = false;
    try {
        const _MC = Function('return (typeof MessageChain !== "undefined") ? MessageChain : null')();
        _merge = !!(_MC && typeof (new _MC()).Node === 'function');
    } catch (e) { }
    let _img = false;
    try {
        const _P = Function('return (typeof puppeteer !== "undefined") ? puppeteer : null')();
        _img = !!(_P && typeof _P.renderHtml === 'function');
    } catch (e) { }
    logger.info('[ai-chat] DSH 接入: {0} (地址={1}, 工具={2}, 直连模式权限≥{3}, 批准权限≥{4}, 合并转发={5}, 图片输出={6}/{7})',
        _c.enabled ? '已启用' : '未启用', _c.baseUrl || '-',
        _c.enabled ? (_c.token ? '就绪' : '缺 token') : '关闭',
        _c.modeMinLevel, _c.approveMinLevel, _merge ? '支持' : '不支持',
        (_c.image && _c.image.enabled !== false) ? (_img ? '可用' : 'puppeteer不可用') : '关闭',
        _c.outputMode || 'auto');
} catch (e) {
    logger.warning('[ai-chat] DSH 状态检查失败: {0}', (e && e.message) || e);
}

logger.info('[ai-chat] AI 对话助手 v{0} 已加载 (plugin_id={1})', VERSION, PLUGIN_ID);
