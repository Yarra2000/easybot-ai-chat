'use strict';

/**
 * 内置工具。
 *
 * 这些工具开箱即用, 也是"让大模型调用 EasyBot 生态能力"的示范:
 *   - 服务器类: 走 sessions / Bridge, 直接操作已连接的 MC 服务器
 *   - RPC 类:   走 Bridge.RpcInvoke, 调用服务器上安装的 EasyBot 扩展(其它插件)
 *   - 记忆类:   读写本插件的长期记忆
 *   - 元工具:   让模型自己查看有哪些工具可用
 */

const util = require('../util.js');
const config = require('../config.js');
const memory = require('../memory.js');
const registry = require('./registry.js');
const permissions = require('../permissions.js');
const playerdb = require('../playerdb.js');
const bind = require('../bind.js');
const cmdbook = require('../cmdbook.js');
const wiki = require('../wiki.js');
const dsh = require('../dsh.js');

/** 把 .NET 对象/集合尽量转成普通 JSON 值 */
function plain(v, depth) {
    depth = depth === undefined ? 0 : depth;
    if (v === null || v === undefined) return v;
    if (depth > 4) return String(v);
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function') return undefined;
    if (Array.isArray(v)) return v.map(function (x) { return plain(x, depth + 1); });
    if (t !== 'object') return String(v);

    // 集合: 用 util.toArray 的多策略 (真实环境实测 .get() 不存在, ToArray() 才有效)
    const looksCollection = (typeof v.Count === 'number') || (typeof v.Length === 'number') ||
        (typeof v.AsArray === 'function');
    if (looksCollection) {
        const arr = util.toArray(v);
        if (arr.length || v.Count === 0 || v.Length === 0) {
            return arr.map(function (x) { return plain(x, depth + 1); });
        }
    }
    const out = {};
    try {
        Object.keys(v).forEach(function (k) {
            const val = plain(v[k], depth + 1);
            if (val !== undefined) out[k] = val;
        });
    } catch (e) { /* ignore */ }
    if (!Object.keys(out).length) {
        // .NET 对象可能不可枚举, 退化成字符串
        try { return JSON.parse(JSON.stringify(v)); } catch (x) { return String(v); }
    }
    return out;
}

/**
 * 清理服务器返回的控制台文本。
 * 实测 EasyBot 的 Text 里: "§r," 是多行的换行标记, "§x§f§f..." 是颜色代码。
 */
function cleanOutput(text) {
    let s = String(text === null || text === undefined ? '' : text);
    s = s.replace(/§r\s*,\s*/g, '\n');   // 先还原换行
    s = s.replace(/§./g, '');             // 再去掉颜色/格式代码
    s = s.replace(/\r/g, '');
    return util.trim(s);
}

/**
 * 是否该对这条指令启用 PAPI 变量解析。
 * 实测: 执行者离线时模组替换占位符会把指令字符串改坏, 所以默认只在在线时启用。
 * @returns {boolean}
 */
function shouldUsePapi(cfg, executorOnline, command) {
    if (cfg && cfg.enablePapi === false) return false;
    // 关键: 指令里没有 %占位符% 时就完全不需要 PAPI。
    // 实测某些服务端的 PAPI 替换会无条件把指令改坏:
    //   开 PAPI 后 list 报 "Unknown or incomplete command"、
    //   effect give PlayerG haste 报 "found trailing data"; 关掉即恢复正常。
    // 而且这与玩家在不在线无关(在线也一样坏)。所以默认只对含占位符的指令开 PAPI。
    const hasPlaceholder = /%[^%\s]+%/.test(String(command || ''));
    if (!hasPlaceholder) return false;
    if (cfg && cfg.papiOnlyWhenOnline !== false && executorOnline === false) return false;
    return true;
}

/**
 * 判断某个玩家名当前是否在线。
 * 实测: Fabric 端桥接按名字找玩家, **不在线时会给一个受限的指令树**
 * (help/list/seed 全报 unknown command)。所以要把在线状态告诉模型/用户。
 * @returns {boolean|null} null 表示查不到(接口失败)
 */
async function isPlayerOnline(server, name) {
    const target = util.trim(String(name || '')).toLowerCase();
    if (!target) return null;
    try {
        const packet = await server.bridge.GetPlayerListAsync();
        const arr = util.toArray(packet && packet.List);
        for (let i = 0; i < arr.length; i++) {
            const pl = arr[i];
            if (!pl) continue;
            const n = String(pl.PlayerName || pl.PlayerNameRaw || '').toLowerCase();
            if (n && n === target) return true;
        }
        return false;
    } catch (e) {
        return null;
    }
}

/**
 * 决定"以谁的服务器身份"执行指令。优先级:
 *   1) 调用方显式给的 playerName (需要管理员开启 allowPlayerCommand)
 *   2) 按 tools.executorMode 决定:
 *        bound(默认)    只用请求者绑定的 MC 玩家
 *        boundIfOnline  绑定玩家在线就用他; 不在线则用 consoleName(适合"常驻在线的OP小号")
 *        console        固定用 consoleName
 *   3) 都没有就用 consoleName 兜底
 *
 * 背景(已从 EasyBot 模组源码确认):
 *   模组的 runCommand 用 CommandSourceStack(控制台身份 + 全权限) 执行指令,
 *   playerName 只用于解析 %player_name% 这类 PAPI 变量 —— 与本插件无关, 传什么都一样。
 *   所以一般不需要改这里的模式; 保留多模式只是为了兼容 Bukkit 等其它平台实现。
 *
 * @returns {Promise<{name:string, source:string, note:string}>}
 */
async function resolveExecutor(args, ctx, server) {
    const cfg = config.get().tools;

    if (args && util.trim(args.playerName)) {
        if (!cfg.allowPlayerCommand) throw new Error('管理员未开启"以玩家身份执行命令"');
        return { name: util.trim(args.playerName), source: 'explicit', note: '' };
    }

    const mode = String(cfg.executorMode || 'bound').toLowerCase();
    const consoleName = util.trim(cfg.consoleName || 'CONSOLE');
    const senderId = (ctx && ctx.senderId) ? String(ctx.senderId) : '';
    const bound = (cfg.runAsBoundPlayer !== false && senderId) ? bind.boundPlayerName(senderId) : '';

    if (mode === 'console') {
        return { name: consoleName, source: 'console', note: '' };
    }
    if (bound) {
        if (mode === 'bound') return { name: bound, source: 'bound', note: '' };
        // boundIfOnline: 在线就用本人, 不在线就让常驻账号代劳
        const online = server ? await isPlayerOnline(server, bound) : null;
        if (online === true || online === null) return { name: bound, source: 'bound', note: '' };
        return {
            name: consoleName, source: 'console-fallback',
            note: '"' + bound + '" 当前不在线, 已改用配置的执行账号 "' + consoleName + '" 代劳' +
                '(需要它是常驻在线的 OP 账号, 否则服务器会给受限的指令树)。'
        };
    }
    return {
        name: consoleName, source: 'console',
        note: '没查到该用户绑定的 MC 玩家, 已用配置的执行账号 "' + consoleName + '"。' +
            '注意: 该名字若不是在线玩家, 部分服务端会给出受限的指令树(很多指令报 unknown command)。'
    };
}

/** 获取可用服务器列表 */
function listServers() {
    const out = [];
    try {
        if (typeof sessions === 'undefined' || !sessions || typeof sessions.GetBridges !== 'function') return out;
        const bridges = util.toArray(sessions.GetBridges());
        bridges.forEach(function (b) {
            try {
                const info = (b && b.Session && b.Session.Info) || null;
                out.push({
                    token: info ? info.CachedServerToken : '',
                    name: (info && info.CachedServerName) || '(未命名服务器)',
                    description: (info && info.CachedServerDescription) || '',
                    version: (info && info.CachedPluginVersion) || '',
                    bridge: b
                });
            } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }
    return out;
}

/**
 * 依据 token 找服务器。
 * 对话场景下不该因为"有多台服务器"就直接失败, 选择顺序:
 *   1) 调用方给的 serverToken
 *   2) 配置里的 tools.defaultServerToken
 *   3) 只有一台在线 -> 就用它
 *   4) 仍然多台 -> 用第一台, 并在结果里标注"多台在线"(由调用工具附带提示)
 */
function resolveServer(token) {
    const servers = listServers();
    if (!servers.length) throw new Error('当前没有已连接的 MC 服务器');
    const pick = function (t) {
        return servers.filter(function (s) { return String(s.token) === String(t); })[0];
    };
    if (token) {
        const hit = pick(token);
        if (!hit) throw new Error('找不到令牌为 ' + token + ' 的服务器');
        return hit;
    }
    if (servers.length === 1) return servers[0];

    const def = util.trim(config.get().tools.defaultServerToken);
    if (def) {
        const hit = pick(def);
        if (hit) return hit;
    }
    const first = servers[0];
    first.multiple = true;
    first.allNames = servers.map(function (s) { return s.name; }).join('、');
    return first;
}

/** 多台服务器时的提示文本 */
function serverNote(server) {
    return server && server.multiple
        ? ('（当前有 ' + server.allNames + ' 多台在线, 本次查询的是「' + server.name + '」；如需指定其它服务器请传 serverToken）')
        : '';
}

/**
 * 指令的"格式 + 硬黑名单"检查 (与权限无关的部分)。
 * 权限分级由 lib/permissions.js 负责。
 */
function checkCommand(command) {
    const cfg = config.get().tools;
    if (!cfg.allowRunCommand) throw new Error('管理员已关闭"允许执行服务器命令"');
    const cmd = permissions.normalizeCommand(command);
    if (!cmd) throw new Error('命令不能为空');
    if (/[\n\r]/.test(String(command))) throw new Error('命令中不允许包含换行');
    if (permissions.isBlacklisted(cmd)) {
        throw new Error('命令 "' + cmd.split(' ')[0] + '" 在黑名单中, 已拒绝执行');
    }
    return cmd;
}

/** 选一个可用的机器人适配器 */
function pickAdapter() {
    if (typeof framework === 'undefined' || !framework || typeof framework.GetAdapters !== 'function') {
        throw new Error('当前 EasyBot 版本不支持 framework API, 无法主动发消息');
    }
    const adapters = util.toArray(framework.GetAdapters());
    if (!adapters.length) throw new Error('没有可用的适配器');
    let fallback = null;
    for (let i = 0; i < adapters.length; i++) {
        const a = adapters[i];
        try {
            const p = a.GetProfile();
            if (p && p.IsActive === false) continue;
            if (p && p.Name) return a;      // 优先选有名字(已登录)的
            if (!fallback) fallback = a;
        } catch (e) { /* 继续 */ }
    }
    return fallback || adapters[0];
}

/** 主动发消息的安全检查 */
function checkSendAllowed(peerId) {
    const cfg = config.get().tools;
    if (!cfg.allowSendMessage) throw new Error('管理员未开启"允许 AI 主动发消息"');
    const allow = util.toArray(cfg.proactiveAllowedGroups).map(String).filter(Boolean);
    if (allow.length && allow.indexOf(String(peerId)) < 0) {
        throw new Error('群 ' + peerId + ' 不在"允许主动发消息的群"列表中');
    }
}

/** 注册全部内置工具 */
function registerAll() {
    const S = 'builtin';

    registry.register({
        name: 'get_current_time',
        description: '获取当前日期和时间。需要知道"现在几点""今天几号"时使用。',
        parameters: { type: 'object', properties: {}, required: [] },
        source: S, plugin: 'eb', qualify: false,
        handler: async function () {
            return { time: util.formatTime(), timestamp: util.now() };
        }
    });

    registry.register({
        name: 'eb_list_servers',
        description: '列出所有已经连接到 EasyBot 的 Minecraft 服务器(名称与令牌)。要操作某台服务器前先用它确认。',
        parameters: { type: 'object', properties: {}, required: [] },
        source: S, plugin: 'eb', qualify: false,
        handler: async function () {
            const servers = listServers();
            if (!servers.length) return { count: 0, servers: [], message: '当前没有已连接的服务器' };
            return {
                count: servers.length,
                servers: servers.map(function (s) {
                    return { name: s.name, token: s.token, description: s.description, pluginVersion: s.version };
                })
            };
        }
    });

    registry.register({
        name: 'eb_server_info',
        description: '获取某台 MC 服务器的基本信息(核心版本、是否支持 PAPI 等)。不传 serverToken 时, 只有一台服务器在线才会自动选择。',
        parameters: {
            type: 'object',
            properties: { serverToken: { type: 'string', description: '服务器令牌, 可用 eb_list_servers 获取' } },
            required: []
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const server = resolveServer(args.serverToken);
            const raw = await server.bridge.GetServerInfo();
            const info = {
                server: server.name,
                name: String((raw && raw.ServerName) || server.name),
                version: String((raw && raw.ServerVersion) || ''),
                pluginVersion: String((raw && raw.PluginVersion) || ''),
                papi: !!(raw && raw.IsPapiSupported),
                commandSupported: !!(raw && raw.IsCommandSupported),
                geyser: !!(raw && raw.HasGeyser),
                onlineMode: !!(raw && raw.IsOnlineMode)
            };
            if (serverNote(server)) info.note = serverNote(server);
            return info;
        }
    });

    registry.register({
        name: 'eb_server_players',
        description: '获取某台 MC 服务器当前的在线玩家列表。',
        parameters: {
            type: 'object',
            properties: { serverToken: { type: 'string', description: '服务器令牌' } },
            required: []
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const server = resolveServer(args.serverToken);
            const packet = await server.bridge.GetPlayerListAsync();
            // 直接读字段: List 是 .NET 集合, 用多策略转数组; 元素按属性名读取
            const list = util.toArray(packet && packet.List);
            const players = list.map(function (p) {
                return {
                    name: String((p && p.PlayerName) || ''),
                    uuid: String((p && p.PlayerUuid) || ''),
                    bedrock: !!(p && p.Bedrock)
                };
            });
            const data = { Success: packet ? packet.Success : undefined, Message: packet ? packet.Message : '' };
            return {
                server: server.name,
                success: data.Success !== false,
                count: players.length,
                players: players,
                message: data.Message || '',
                note: serverNote(server)
            };
        }
    });

    registry.register({
        name: 'eb_run_command',
        description: '在某台 MC 服务器上执行一条指令, 并返回服务器控制台输出。' +
            '会按调用者的等级校验(不足会被拒绝); 危险命令另有黑名单拦截。' +
            '如果返回 unknown command, 说明本服不认这条指令 —— 别重试, 换本服支持的写法或如实告知对方。' +
            '【指令来源优先级】① 下面的本服知识库/专用规则工具; ② eb_find_command 检索知识库; ' +
            '③ 仍然没有才用 eb_search_wiki 查 Minecraft Wiki 的原版写法(但必须告诉用户那是原版写法、未必适用本服, ' +
            '并且不要直接拿 Wiki 写法执行会改变服务器状态的指令, 先让用户确认)。' + cmdbook.forToolDescription(),
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '要执行的命令, 不需要带开头的斜杠' },
                serverToken: { type: 'string', description: '服务器令牌, 可省略' },
                playerName: { type: 'string', description: '以该玩家身份执行(通常不需要填)' }
            },
            required: ['command']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args, ctx) {
            const cfg = config.get().tools;
            if (!cfg.allowRunCommand) throw new Error('管理员已关闭"允许执行服务器命令"');

            const raw = util.trim(args.command);
            let command = permissions.normalizeCommand(raw);
            if (!command) throw new Error('命令不能为空');

            // 按配置的改写规则纠正指令(例如本服白名单要用 easywhitelist 而不是 whitelist)
            try {
                const rr = require('./rules.js').applyRewrites(command);
                if (rr.changed) {
                    logger.info('[ai-chat] 指令按改写规则调整: {0} -> {1}  (规则: {2})', command, rr.command, rr.rule);
                    command = rr.command;
                }
            } catch (e) { /* ignore */ }

            // 命中知识库时记一条日志(方便管理员看出"模型到底按哪条执行的")
            try {
                const hit = cmdbook.matchEntry(command);
                if (hit) logger.info('[ai-chat] 指令命中知识库: {0}  (等级 {1})', hit.command, hit.level === null ? '未声明' : hit.level);
            } catch (e) { /* ignore */ }

            // ---- 按调用者身份做权限校验 ----
            const level = permissions.levelOf(ctx);
            const verdict = permissions.check(level, command);
            if (!verdict.ok) {
                logger.info('[ai-chat] 拒绝指令(等级 {0}, {1}): {2} —— {3}',
                    level, permissions.levelName(level), command, verdict.reason);
                return {
                    success: false,
                    denied: true,
                    command: command,
                    yourLevel: level,
                    yourLevelName: permissions.levelName(level),
                    neededLevel: verdict.need,
                    reason: verdict.reason,
                    hint: '不要重试。直接告诉对方他没有权限, 并说明需要什么等级。'
                };
            }
            if (permissions.isBlacklisted(command)) {
                return { success: false, denied: true, command: command, reason: '该指令在硬黑名单里, 任何人都不能执行' };
            }

            const server = resolveServer(args.serverToken);
            const exec = await resolveExecutor(args, ctx, server);

            const online = await isPlayerOnline(server, exec.name);
            // ★ 实测踩坑: 模组的 PAPI 替换会拿 playerName 去解析 %player_name% 之类的变量,
            //   执行者离线时它拿到的是 null, 结果把**指令字符串改坏** ——
            //   list 报 "Unknown or incomplete command"、time set day 报 "Expected float"、
            //   gamemode survival 报 "found trailing data", 看起来像权限/指令不存在, 其实是指令被改坏了。
            //   所以默认只在执行者在线时才开 PAPI(可用 tools.papiOnlyWhenOnline 调整)。
            const usePapi = shouldUsePapi(cfg, online, command);
            if (cfg.enablePapi !== false && !/%[^%\s]+%/.test(command)) {
                logger.info('[ai-chat] 指令不含 PAPI 占位符, 已跳过 PAPI 替换(避免被服务端改坏)');
            } else if (usePapi === false && cfg.enablePapi !== false) {
                logger.info('[ai-chat] 执行者 {0} 不在线, 已跳过 PAPI 变量解析', exec.name);
            }
            const packet = await server.bridge.SendRunCommandAsync(exec.name, command, usePapi);
            const output = cleanOutput((packet && packet.Text) || '');

            // 指令被服务端拒绝时给出可操作的说明。
            // 说明: EasyBot 模组是以"控制台 + 全权限"(PermissionSet.ALL_PERMISSIONS)执行指令的,
            //       playerName 只用于解析 PAPI 变量, 因此报 unknown command 与"谁在线"无关,
            //       而是服务端的指令树/权限过滤, 或指令本身在本服不存在/语法不同。
            const looksUnknown = /unknown or incomplete command|unknown command|Unknown command/i.test(output);
            const looksArgErr = /Incorrect argument|Expected |trailing data|Usage:/i.test(output);
            const warnings = [];
            if (looksUnknown || looksArgErr) {
                warnings.push('这条指令服务器没执行成功。指令是以控制台全权限下发的, ' +
                    '常见原因是: (1) 指令在本服不存在或被改名(用 tools.commandHints 写清楚本服可用指令); ' +
                    '(2) 开了 PAPI 变量解析但执行者不在线导致指令被改坏(插件已尽量自动规避)。' +
                    '请换用本服确实支持的写法, 不要反复重试同一条。');
            }
            logger.info('[ai-chat] 执行指令(等级 {0}, 身份 {1}/{2}): {3} -> {4}',
                level, exec.name, exec.source, command, util.truncate(output.replace(/\s+/g, ' '), 120));
            return {
                success: !(packet && packet.Success === false),
                command: command,
                rawRequested: permissions.normalizeCommand(raw),
                server: server.name,
                executedAs: exec.name,
                executedAsSource: exec.source,
                executorOnline: online,
                // 服务器控制台输出(已去掉颜色代码)
                output: output,
                hasOutput: !!util.trim(output),
                outputEmptyHint: util.trim(output)
                    ? ''
                    : '(服务器没有返回文字输出: 该指令可能只是广播/无回显, 例如 say)',
                level: level,
                tier: verdict.tier,
                papi: usePapi,
                note: [serverNote(server), exec.note, warnings.join(' ')].filter(Boolean).join(' ')
            };
        }
    });

    registry.register({
        name: 'eb_broadcast',
        description: '向某台 MC 服务器的所有在线玩家广播一条聊天消息。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要广播的文本' },
                serverToken: { type: 'string', description: '服务器令牌, 可省略' }
            },
            required: ['text']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const text = util.trim(args.text);
            if (!text) throw new Error('广播内容不能为空');
            const server = resolveServer(args.serverToken);
            server.bridge.SendMessageToAllPlayer(text);
            return { success: true, server: server.name, text: text };
        }
    });

    registry.register({
        name: 'eb_placeholder',
        description: '向服务器查询 PlaceholderAPI 变量, 例如查询玩家的等级、金币。',
        parameters: {
            type: 'object',
            properties: {
                playerName: { type: 'string', description: '玩家名' },
                text: { type: 'string', description: '带有 PAPI 变量的文本, 例如 %player_level%' },
                serverToken: { type: 'string', description: '服务器令牌, 可省略' }
            },
            required: ['playerName', 'text']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const server = resolveServer(args.serverToken);
            const packet = await server.bridge.SendPlaceholderApiQueryAsync(String(args.playerName), String(args.text));
            return {
                success: !(packet && packet.Success === false),
                text: String((packet && packet.Text) || ''),
                server: server.name,
                note: serverNote(server)
            };
        }
    });

    registry.register({
        name: 'eb_rpc_call',
        description: '调用服务器上安装的 EasyBot 扩展(其它插件/模组)暴露的方法。identifier 是扩展标识符(如 bridge:test), method 是方法名, args 是参数对象。',
        parameters: {
            type: 'object',
            properties: {
                identifier: { type: 'string', description: '扩展标识符, 例如 bridge:test' },
                method: { type: 'string', description: '方法名' },
                args: { type: 'object', description: '传给该方法的参数对象' },
                serverToken: { type: 'string', description: '服务器令牌, 可省略' }
            },
            required: ['identifier', 'method']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const server = resolveServer(args.serverToken);
            const result = await server.bridge.RpcInvoke(String(args.identifier), String(args.method), args.args || {});
            return plain(result);
        }
    });

    registry.register({
        name: 'eb_list_extensions',
        description: '列出某台服务器上安装的 EasyBot 扩展清单(可调用 RPC 的插件/模组)。',
        parameters: {
            type: 'object',
            properties: { serverToken: { type: 'string', description: '服务器令牌, 可省略' } },
            required: []
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const server = resolveServer(args.serverToken);
            const packet = await server.bridge.GetExtensions();
            return plain(packet);
        }
    });

    registry.register({
        name: 'eb_list_tools',
        description: '列出你当前可以调用的全部工具及其用途。不确定有什么能力时使用。',
        parameters: { type: 'object', properties: {}, required: [] },
        source: S, plugin: 'eb', qualify: false,
        handler: async function () {
            return registry.list().map(function (t) {
                return { name: t.name, source: t.source, from: t.plugin, description: util.truncate(t.description, 160) };
            });
        }
    });

    registry.register({
        name: 'eb_send_to_group',
        description: '主动向指定的 QQ 群发送一条消息。需要管理员开启"允许 AI 主动发消息"。',
        parameters: {
            type: 'object',
            properties: {
                groupId: { type: 'string', description: '目标群号' },
                text: { type: 'string', description: '要发送的内容' }
            },
            required: ['groupId', 'text']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const groupId = util.trim(args.groupId);
            const text = util.trim(args.text);
            if (!groupId || !text) throw new Error('groupId 与 text 都不能为空');
            checkSendAllowed(groupId);
            const adapter = pickAdapter();
            const profile = adapter.GetProfile();
            const selfId = String((profile && profile.Id) || '');
            const chain = new MessageChain().Text(text);
            const msgId = await adapter.GetAdapterContext().SendGroupMessageAsync(selfId, groupId, chain);
            return { success: true, groupId: groupId, selfId: selfId, messageId: String(msgId === undefined || msgId === null ? '' : msgId), text: text };
        }
    });

    registry.register({
        name: 'eb_send_to_user',
        description: '主动给指定 QQ 用户发一条私聊消息。需要管理员开启"允许 AI 主动发消息"。',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: '目标用户 QQ' },
                text: { type: 'string', description: '要发送的内容' }
            },
            required: ['userId', 'text']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const userId = util.trim(args.userId);
            const text = util.trim(args.text);
            if (!userId || !text) throw new Error('userId 与 text 都不能为空');
            if (!config.get().tools.allowSendMessage) throw new Error('管理员未开启"允许 AI 主动发消息"');
            const adapter = pickAdapter();
            const profile = adapter.GetProfile();
            const selfId = String((profile && profile.Id) || '');
            const chain = new MessageChain().Text(text);
            const msgId = await adapter.GetAdapterContext().SendDirectMessageAsync(selfId, userId, chain);
            return { success: true, userId: userId, selfId: selfId, messageId: String(msgId === undefined || msgId === null ? '' : msgId) };
        }
    });

    registry.register({
        name: 'eb_my_permissions',
        description: '查询当前和你说话的人拥有哪些服务器指令权限(等级、可执行的指令类型)。当对方要求你执行 MC 指令、或你想确认自己能不能代他操作服务器时, 先调用这个。',
        parameters: { type: 'object', properties: {}, required: [] },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args, ctx) {
            const level = permissions.levelOf(ctx);
            const pcfg = config.permissions() || {};
            const sid = (ctx && ctx.senderId) ? String(ctx.senderId) : '';
            return {
                senderName: (ctx && ctx.senderName) || '',
                senderId: sid,
                groupRole: (ctx && ctx.senderRole) || '',
                boundMcPlayers: bind.boundPlayers(sid),
                bindApiAvailable: bind.available(),
                level: level,
                levelName: permissions.levelName(level),
                canRunCommand: level >= 1,
                canRunDangerous: level >= Number(pcfg.unknownCommandLevel === undefined ? 3 : pcfg.unknownCommandLevel),
                safeCommands: pcfg.safeCommands || [],
                mediumCommands: pcfg.mediumCommands || [],
                blockedCommands: config.get().tools.commandBlacklist || [],
                summary: permissions.describeFor(ctx)
            };
        }
    });

    registry.register({
        name: 'eb_net_http_probe',
        description: '诊断: 用 .NET 的 HttpClient 自己发一次 HTTP 请求(请求头完全可控), 用来验证当前环境能否自行发请求。',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: '要 POST 的目标地址(必填), 例如 http://127.0.0.1:8080/echo' }
            },
            required: ['url']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const out = { steps: [] };
            const targetUrl = String((args && args.url) || '').trim();
            if (!targetUrl) return { ok: false, error: '缺少 url 参数(要 POST 的目标地址)' };
            const step = function (name, val) { out.steps.push(name + ': ' + val); };

            let Sys = null;
            try {
                const dn = Function('return (typeof dotnet !== "undefined") ? dotnet : null')();
                if (!dn) throw new Error('没有 dotnet 全局');
                step('dotnet.System', typeof dn.System);
                Sys = dn.System;
            } catch (e) { return { ok: false, error: String(e.message), steps: out.steps }; }

            // 列出 System 下我们能看到的命名空间/类型(找 Http / Net)
            try {
                const names = Object.getOwnPropertyNames(Sys).slice(0, 60);
                step('System 成员(前60)', names.join(','));
            } catch (e) { step('列 System 成员失败', String(e.message)); }

            const get = function (path) {
                let cur = Sys;
                const parts = path.split('.');
                for (let i = 0; i < parts.length; i++) {
                    if (cur === null || cur === undefined) throw new Error('在 ' + parts[i] + ' 处为空');
                    cur = cur[parts[i]];
                }
                if (cur === undefined) throw new Error('取不到 ' + path);
                return cur;
            };

            ['Net.Http.HttpClient', 'Net.Http.StringContent', 'Net.Http.HttpMethod',
                'Text.Encoding', 'Uri', 'TimeSpan'].forEach(function (p2) {
                try { step('可取到 ' + p2, typeof get(p2)); }
                catch (e) { step('❌ ' + p2, String(e.message)); }
            });

            // ★ 真正试一次: 用 .NET HttpClient POST 到调用者给的地址, 看请求头是否完全可控
            try {
                const HttpClient = get('Net.Http.HttpClient');
                const StringContent = get('Net.Http.StringContent');
                const Encoding = get('Text.Encoding');
                const Uri = get('Uri');

                const client = new HttpClient();
                try {
                    const TimeSpan = get('TimeSpan');
                    client.Timeout = TimeSpan.FromSeconds(20);
                } catch (e) { step('设置超时失败(忽略)', String(e.message)); }

                try {
                    client.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', 'Bearer dotnet-probe');
                    client.DefaultRequestHeaders.TryAddWithoutValidation('X-Dotnet-Probe', 'yes');
                } catch (e) { step('加请求头失败', String(e.message)); }

                const body = JSON.stringify({ probe: 'dotnet-httpclient', 中文: 1 });
                const content = new StringContent(body, Encoding.UTF8, 'application/json');

                // 三种等待 Task 的方式, 只要有一种通就行
                let resp = null, how = '';
                const task = client.PostAsync(new Uri(targetUrl), content);
                try {
                    resp = await task;
                    how = 'await task';
                } catch (e1) {
                    try { resp = task.GetAwaiter().GetResult(); how = 'GetAwaiter().GetResult()'; }
                    catch (e2) { step('❌ 等待 Task 失败', String(e1.message) + ' / ' + String(e2.message)); }
                }
                if (resp) {
                    step('POST /echo 成功, 等待方式=' + how, 'Status=' + resp.StatusCode);
                    let text = '';
                    try {
                        const t2 = resp.Content.ReadAsStringAsync();
                        text = (typeof t2 === 'string') ? t2 : await t2;
                    } catch (e) { text = '(读 body 失败: ' + String(e.message) + ')'; }
                    step('服务器回显(看 ctype)', String(text).slice(0, 300));
                }

                // ② 用同一个 client 直连 Agnes /v1/models(带插件配置里的真 key)
                try {
                    const cfg = config.llm();
                    if (cfg.apiKey) {
                        const c2 = new HttpClient();
                        c2.DefaultRequestHeaders.TryAddWithoutValidation('Authorization', 'Bearer ' + cfg.apiKey);
                        const r2 = c2.GetAsync(new Uri('https://api.deepseek.com/v1/models'));
                        let resp2 = null;
                        try { resp2 = await r2; } catch (e) { resp2 = r2.GetAwaiter().GetResult(); }
                        step('★ 直连 Agnes /v1/models', 'Status=' + resp2.StatusCode);
                        let tt = '';
                        try { const t3 = resp2.Content.ReadAsStringAsync(); tt = (typeof t3 === 'string') ? t3 : await t3; } catch (e) { }
                        step('   响应片段', String(tt).slice(0, 200));
                    }
                } catch (e) { step('直连 Agnes 失败', String(e.message).slice(0, 160)); }

            } catch (e) {
                step('❌ HttpClient 流程失败', String((e && e.message) || e).slice(0, 200));
            }

            return { ok: true, steps: out.steps };
        }
    });

    registry.register({
        name: 'eb_player_data',
        description: '查询某个玩家(在线或**离线**都行)的存档数据: 背包/装备/末影箱(inventory)、成就(advancements)、统计数据(stats)。' +
            '当有人问"某某背包里有什么""他有钻石吗""他穿什么装备""他玩多久了""挖了多少石头""有哪些成就"时用这个。',
        parameters: {
            type: 'object',
            properties: {
                player: { type: 'string', description: 'MC 玩家名(区分大小写)' },
                server: { type: 'string', description: '可选: 指定哪个服务器(如 示例服)。同名玩家在不同服务器有不同存档' },
                what: {
                    type: 'string',
                    enum: ['inventory', 'advancements', 'stats'],
                    description: 'inventory=背包+装备+末影箱(默认), advancements=成就, stats=统计数据'
                }
            },
            required: ['player']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args, ctx) {
            const cfg = config.get().tools || {};
            const pd = cfg.playerData || {};
            if (pd.enabled === false) throw new Error('管理员关闭了玩家数据查询');

            const who = util.trim(args.player);
            if (!who) throw new Error('需要玩家名');

            // 权限: 查自己绑定的号随便查; 查别人需要等级
            const sid = (ctx && ctx.senderId) ? String(ctx.senderId) : '';
            const mine = bind.boundPlayers(sid);
            const isMine = mine.some(function (n) { return String(n).toLowerCase() === who.toLowerCase(); });
            if (!isMine) {
                const minLevel = Number(pd.minLevel === undefined ? 1 : pd.minLevel);
                const level = permissions.levelOf(ctx);
                if (level < minLevel) {
                    return {
                        success: false, denied: true, player: who,
                        reason: '查询他人背包需要等级 ' + minLevel + '，你当前是 ' + level + ' 级',
                        yourBoundPlayers: mine
                    };
                }
            }

            const what = String(args.what || 'inventory').toLowerCase();
            const r = await playerdb.read(who, what, args.server);
            if (!r.ok) {
                const errOut = { success: false, player: who, error: r.error, tried: r.tried || [], hint: r.hint || '',
                    nbtEnumValues: (playerdb.nbtEnumNames ? playerdb.nbtEnumNames() : ''),
                    note: r.unsupported
                        ? '背包和统计数据可用; 成就(Advancements)需要更新的服务端模组, 当前模组版本未实现'
                        : '该玩家可能从未在这个服务器玩过' };
                if (r.availableServers) {
                    errOut.availableServers = r.availableServers;
                    errOut.note = '该玩家在多个服务器有存档, 请用 server 参数指定其中一个再试';
                }
                return errOut;
            }

            const maxItems = Number(pd.maxItems) || 60;
            if (what === 'stats') {
                return { success: true, player: who, uuid: r.uuid, server: r.server, kind: 'stats',
                    allServers: r.allServers, stats: playerdb.summarizeStats(r.data, maxItems) };
            }
            if (what === 'advancements') {
                return { success: true, player: who, uuid: r.uuid, server: r.server, kind: 'advancements',
                    allServers: r.allServers, advancements: playerdb.summarizeAdvancements(r.data, 80) };
            }
            const inv = playerdb.summarizeInventory(r.data, maxItems);
            return {
                success: true, player: who, uuid: r.uuid, server: r.server, kind: 'inventory', allServers: r.allServers,
                itemKinds: inv.count, items: inv.items, equipment: inv.equipment,
                enderChest: inv.enderChest, enderCount: inv.enderCount, vitals: inv.vitals,
                note: '物品名是 MC 内部 id(已去掉 minecraft: 前缀), 用中文向对方解释即可'
            };
        }
    });

    registry.register({
        name: 'eb_http_probe',
        description: '诊断工具: 尝试各种 network 调用姿势, 判断插件能否发送自定义请求头(Authorization 等)。',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要探测的地址(会带上探测用的 Authorization 头)' } },
            required: ['url']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const url = util.trim(args.url);
            const out = [];
            if (typeof network === 'undefined' || !network) return { ok: false, error: 'network 不可用' };

            async function attempt(name, fn) {
                try {
                    const r = await fn();
                    let echo = '';
                    try { echo = util.truncate(String((r && (r.body || (r.data && util.safeStringify(r.data)))) || ''), 200); } catch (e2) { }
                    out.push({ attempt: name, ok: true, status: (r && r.status) || null, response: echo });
                } catch (e) {
                    out.push({ attempt: name, ok: false, error: util.truncate(String((e && e.message) || e), 150) });
                }
            }

            // ① JS 字面量对象
            await attempt('request({url,method,headers:{...}})', function () {
                return network.request({ url: url, method: 'GET', headers: { Authorization: 'Bearer probe-js-object' } });
            });
            // ② 位置参数
            await attempt('request(url,method,headers)', function () {
                return network.request(url, 'GET', { Authorization: 'Bearer probe-positional' });
            });
            // ③ 构造 RequestMessage(如果宿主暴露了类型)
            await attempt('new RequestMessage()', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('宿主没有暴露 RequestMessage 类型');
                const m = new R();
                m.url = url; m.method = 'GET';
                return network.request(m);
            });
            // ③b 用 RequestMessage 自带的 headers(构造函数通常已预置实例)
            await attempt('RequestMessage + m.headers.Set(Authorization)', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('宿主没有暴露 RequestMessage 类型');
                const m = new R();
                m.url = url; m.method = 'GET';
                const hs = m.headers || m.Headers;
                if (!hs || typeof hs.Set !== 'function') {
                    throw new Error('RequestMessage.headers 不是可用的 HeaderCollection: ' + typeof hs);
                }
                hs.Set('Authorization', 'Bearer probe-via-headers-set');
                hs.Set('X-Probe', 'yes');
                hs.Set('Content-Type', 'application/json');
                hs.Set('User-Agent', 'easybot-ai-chat/1.0 (probe)');
                return network.request(m);
            });
            // ③c body 传"对象"而不是字符串 —— 宿主可能自动 JSON 序列化并设成 application/json
            await attempt('RequestMessage + body 传对象', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('无 RequestMessage');
                const m = new R();
                m.url = url; m.method = 'POST';
                const hs = m.headers || m.Headers;
                if (hs && typeof hs.Set === 'function') hs.Set('X-Probe', 'object-body');
                m.body = { probe: 1, text: '中文' };
                return network.request(m);
            });
            // ③d body 传对象 + 显式头
            await attempt('RequestMessage + body 对象 + 头', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('无 RequestMessage');
                const m = new R();
                m.url = url; m.method = 'POST';
                const hs = m.headers || m.Headers;
                if (hs && typeof hs.Set === 'function') {
                    hs.Set('X-Probe', 'object-body-headers');
                    hs.Set('Authorization', 'Bearer obj-body');
                }
                m.body = { probe: 2 };
                return network.request(m);
            });
            // ③e 列出 RequestMessage 的真实成员(找有没有 contentType 之类的属性)
            await attempt('列出 RequestMessage 成员', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('无 RequestMessage');
                const m = new R();
                let keys = [];
                try { keys = Object.keys(m); } catch (e) { }
                let props = [];
                try {
                    props = util.toArray(m.GetType().GetProperties()).map(function (p) { return p.Name; });
                } catch (e) { }
                throw new Error('keys=[' + keys.join('|') + '] props=[' + props.join('|') + ']');
            });
            // ③f 试 contentType / ContentType 属性
            await attempt('RequestMessage + contentType 属性', function () {
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!R) throw new Error('无 RequestMessage');
                const m = new R();
                m.url = url; m.method = 'POST'; m.body = '{"probe":3}';
                const hs = m.headers || m.Headers;
                if (hs && typeof hs.Set === 'function') hs.Set('X-Probe', 'contenttype-prop');
                let set = [];
                ['contentType', 'ContentType', 'content_type'].forEach(function (k) {
                    try { if (m[k] !== undefined) { m[k] = 'application/json'; set.push(k); } } catch (e) { }
                });
                if (!set.length) throw new Error('没有 contentType 属性可用');
                return network.request(m);
            });
            // ④ 构造 HeaderCollection
            await attempt('new HeaderCollection() + request', function () {
                const H = (typeof HeaderCollection !== 'undefined') ? HeaderCollection : null;
                const R = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
                if (!H || !R) throw new Error('宿主没有暴露 HeaderCollection/RequestMessage');
                const h = new H();
                if (typeof h.Set === 'function') h.Set('Authorization', 'Bearer probe-headercollection');
                const m = new R();
                m.url = url; m.method = 'GET'; m.headers = h;
                return network.request(m);
            });
            // ⑤ 最简签名(对照组)
            await attempt('get(url)', function () { return network.get(url); });
            // ⑥ post 带 body
            await attempt('post(url,body)', function () { return network.post(url, '{"probe":1}'); });

            return { url: url, results: out };
        }
    });

    registry.register({
        name: 'eb_find_command',
        description: '在本服的指令知识库里查找该用哪条指令。' +
            '不确定本服指令写法时先调用它(本服可能与原版不同, 例如白名单是 easywhitelist 而不是 whitelist)。' +
            '查询词请用"功能词"而不是用户的整句话(例如用户说"把我朋友拉进来", 你应该查"白名单")。' +
            '如果没查到, 会返回本服全部指令清单, 你可以从中挑最接近的, 或换个词再查一次。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '要查找的功能或关键词, 例如: 白名单 / 传送 / 给物品 / 时间' }
            },
            required: ['query']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const q = util.trim(args.query);
            // 允许空查询/通配: 直接列出全部指令, 方便模型浏览
            const browse = (!q || q === '*' || q === '全部' || q === 'all');
            const hits = browse ? cmdbook.parse() : cmdbook.search(q);
            return {
                query: q || '(全部)',
                found: hits.length,
                browsed: browse,
                result: cmdbook.searchText(q),
                entries: browse ? hits : hits
            };
        }
    });

    // ★ 模组百科(mcmod.cn) —— 原版 Wiki 查不到的模组内容在这里查 ✓
    registry.register({
        name: 'eb_search_mcmod',
        description: '查询【模组】相关内容 —— Minecraft 模组百科 mcmod.cn（原版 Wiki 查不到的模组东西在这里查）。' +
            '★ 什么时候用：用户问的是【模组里的】物品/方块/机器/机制/模组本身（例：机械动力的粉碎轮怎么用、匠魂熔炉、抽屉模组），' +
            '优先用本工具 ✓；只有问【原版】内容（原版指令/原版生物/原版方块）才用 eb_search_wiki ✓。' +
            '★ 关键词用【中文】的模组名/物品名，2~4 个词就够（例：机械动力 / 抽屉 / 匠魂 熔炉），不要堆一长串。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '关键词（中文模组名/物品名/机制名，2~4 个词）' },
                limit: { type: 'number', description: '返回几条，默认 5，最多 10' },
                deep: { type: 'boolean', description: '是否深入打开第一条详情页, 抓简介和正文插图(默认 true)。讲"用法/怎么获得"时保持 true ✓' }
            },
            required: ['query']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args, ctx) {
            const q = util.trim(args.query);
            if (!q) throw new Error('查询关键词不能为空');
            let list;
            try {
                list = await wiki.searchMcmod(q, Number(args.limit) || 5);
            } catch (e) {
                const msg = String((e && e.message) || e);
                logger.warning('[ai-chat] MC百科 查询失败: {0}', util.truncate(msg, 160));
                return { success: false, error: msg,
                    advice: 'MC百科 暂时访问不了，可以换关键词再试一次；如果一直失败就直接告诉用户查不到。' };
            }
            logger.info('[ai-chat] MC百科 查询 "{0}" -> {1} 条结果', q, list.length);
            // ★ 深入第一条: 抓简介 + 正文插图(图片会跟在回复后面真的发出去 ✓)
            let page = null;
            if (args.deep !== false && list.length) {
                try {
                    page = await wiki.mcmodPage(list[0].url);
                    if (page && page.images && page.images.length && ctx && ctx.sessionKey) {
                        wiki.stashImages(ctx.sessionKey, page.images);
                    }
                    logger.info('[ai-chat] MC百科 详情: {0} 图片 {1} 张', util.truncate(page.title, 40), (page.images || []).length);
                } catch (e) {
                    logger.warning('[ai-chat] MC百科 详情页抓取失败: {0}', util.truncate(String((e && e.message) || e), 120));
                }
            }
            if (!list.length) {
                return { success: true, query: q, source: 'MC百科', found: 0,
                    result: 'MC百科 没搜到「' + q + '」。换个更短的模组名/物品名再试一次（例：把"机械动力的粉碎轮怎么用"缩短成"粉碎轮"）。' };
            }
            // ★ 不给模型看网址(用户要的是图片, 不是链接 ✗); 图片会自动跟在回复后面发出去 ✓
            const text = '在 MC百科（mcmod.cn）上查到：\n' + list.map(function (r, i) {
                return (i + 1) + '. ' + r.title + '\n   ' + r.snippet;
            }).join('\n');
            return { success: true, query: q, source: 'MC百科', found: list.length,
                result: text +
                    (page && page.sections && page.sections.length
                        ? ('\n\n【' + page.title + ' 的资料】\n' + page.sections.join('\n'))
                        : (page && page.desc ? ('\n\n【' + page.title + '】' + page.desc) : '')) +
                    (page && page.images && page.images.length
                        ? ('\n（原文插图 ' + page.images.length + ' 张会自动附在回复后面，不要在文字里贴链接 ✓）')
                        : ''),
                results: list, page: page };
        }
    });


    // ★ 读 EasyBot 自己的运行日志(排查"为什么没反应/是不是报错了")
    registry.register({
        name: 'eb_read_log',
        description: '读 EasyBot/机器人的运行日志（最近的若干行，可按关键词或级别过滤）。' +
            '★ 什么时候用：用户问"刚才是不是报错了 / 机器人怎么没反应 / 为什么没回我 / 看看日志"时；' +
            '或你要确认某个功能有没有真的执行（工具调用、指令执行、插件加载、桥接事件）✓' +
            '★ source 参数：easybot(默认, 机器人自己的日志)；其它来源由管理员的 tools.logSources 配置决定。' +
            '问"服务端崩溃/卡顿/报错/tps"这类 → 用对应的 mc-* ✓；问"机器人为什么没反应/工具执行了吗" → 用 easybot ✓。' +
            '★ 如果 mc-* 报"文件不存在"，说明管理员还没把服务端日志同步进来 —— 如实告诉用户，不要编造服务端内容。' +
            '★ 用法建议：先用 keyword 精确过滤（如 tavily、item-mail、玩家名、报错），再看结果，别一次拉几百行。' +
            '★ 能查历史日志：file="list" 列出有哪些历史文件；file="2026-10-01" 查那天的日志（服务端 .log.gz、EasyBot .logs.zip 都能自动解压）✓' +
            '★ 【需要权限】日志里有玩家名/聊天/令牌，只有管理员能用。如果返回 needPermission，就不要再看，' +
            '直接告诉用户"看日志需要管理员权限" ✓',
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '只保留包含该关键词的行(不区分大小写)，例如 tavily、item-mail、玩家名、失败' },
                lines: { type: 'number', description: '返回最近多少行，默认 60，最多 200' },
                level: { type: 'string', description: 'all(默认) / error(只看 ERR/FTL) / warn(ERR+WRN)' },
                source: { type: 'string', description: '日志来源；easybot(默认) 或管理员配置的其它来源 key' },
                file: { type: 'string', description: 'latest(默认, 当前日志) / list(列出有哪些历史文件) / 日期或文件名(如 2026-10-01) 查历史日志' }
            }
        },
        source: S,
        plugin: 'eb',
        qualify: false,
        handler: async function (args, ctx) {
            try {
                // ★ 权限闸门: 日志含玩家名/聊天/令牌, 必须管理员才给看 ✗
                const _needRaw = Number((config.get().tools || {}).logReadMinLevel);
                const _need = isNaN(_needRaw) ? 3 : _needRaw;
                const _permLv = permissions.levelOf(ctx || {});
                if (_permLv < _need) {
                    const sid = (ctx && ctx.senderId) ? String(ctx.senderId) : '?';
                    logger.info('[ai-chat] 拒绝读日志: 发送者 {0} 等级 {1} < 需要 {2}', sid, _permLv, _need);
                    return {
                        success: false,
                        needPermission: true,
                        senderLevel: _permLv,
                        requiredLevel: _need,
                        error: '查看日志需要权限等级 ' + _need + '（' + permissions.levelName(_need) + '），你当前是 ' +
                            _permLv + '（' + permissions.levelName(_permLv) + '）',
                        advice: '不要再看日志，也不要换个关键词重试。直接告诉用户：查看日志需要管理员权限，请找管理员。'
                    };
                }
                const Sys = Function('return (typeof dotnet !== "undefined") ? dotnet.System : null')();
                if (!Sys || !Sys.IO || !Sys.IO.File) return { success: false, error: '当前环境无法读取文件' };
                const src = String(args.source || 'easybot').toLowerCase();
                // ★ 来源由配置决定（tools.logSources: [{key, name, paths:[...]}]）—— 不在代码里写死任何服务器 ✗
                const MAP = { 'easybot': ['/app/logs/latest.log'] };
                try {
                    const ls = ((config.get() || {}).tools || {}).logSources || [];
                    for (let i = 0; i < ls.length; i++) {
                        const x = ls[i] || {};
                        if (x && x.key && x.paths && x.paths.length) MAP[String(x.key)] = x.paths.map(String);
                    }
                } catch (e) { }
                const cands = MAP[src] || MAP['easybot'];
                let p = '';
                for (let i = 0; i < cands.length; i++) {
                    if (Sys.IO.File.Exists(cands[i])) { p = cands[i]; break; }
                }
                if (!p) {
                    return {
                        success: false, source: src, file: cands[0],
                        tried: cands,
                        error: '服务端日志没接进来：这些位置都不存在 → ' + cands.join(' , '),
                        advice: (src === 'easybot')
                            ? 'EasyBot 自己的日志都读不到，请管理员检查容器内 /app/logs 是否挂载。'
                            : '这个来源的日志文件不存在 ✗。请让管理员在插件配置的 tools.logSources 里登记路径，' +
                              '或者把服务端日志目录以只读方式挂进 EasyBot 容器 ✓'
                    };
                }
                // ★ 历史日志：支持 list 列出、按日期/文件名选择、自动解压 .gz / .zip
                const _dir = p.replace(/[\\/][^\\/]*$/, '');
                function _listFiles() {
                    try {
                        const arr = Sys.IO.Directory.GetFiles(_dir) || [];
                        const out = [];
                        for (let i = 0; i < arr.length; i++) {
                            const full = String(arr[i]);
                            const name = full.replace(/^.*[\\/]/, '');
                            if (!/\.log$|\.log\.gz$|\.logs\.zip$/.test(name)) continue;
                            let size = 0, mtime = '';
                            try {
                                const fi = Sys.Activator.CreateInstance(Sys.IO.FileInfo, full);
                                size = Number(fi.Length) || 0;
                            } catch (e) { size = 0; }
                            try { mtime = String(Sys.IO.File.GetLastWriteTime(full)); } catch (e) { }
                            out.push({ name: name, size: size, mtime: mtime, full: full });
                        }
                        out.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
                        return out;
                    } catch (e) { return []; }
                }
                function _readText(file) {
                    const low = file.toLowerCase();
                    if (low.endsWith('.gz')) {
                        const asm = Sys.Reflection.Assembly.Load('System.IO.Compression');
                        const GZip = asm.GetType('System.IO.Compression.GZipStream');
                        const ModeT = asm.GetType('System.IO.Compression.CompressionMode');
                        const mode = ModeT.GetField('Decompress').GetValue(null);
                        const fs = Sys.IO.File.OpenRead(file);
                        const gz = Sys.Activator.CreateInstance(GZip, fs, mode);
                        const reader = new Sys.IO.StreamReader(gz, Sys.Text.Encoding.UTF8);
                        try { return String(reader.ReadToEnd()); } finally { try { reader.Dispose(); } catch (e) { } }
                    }
                    if (low.endsWith('.zip')) {
                        const asm = Sys.Reflection.Assembly.Load('System.IO.Compression.FileSystem');
                        const ZipFile = asm.GetType('System.IO.Compression.ZipFile');
                        const strType = Sys.Type.GetType('System.String');
                        const mi = ZipFile.GetMethod('OpenRead', [strType]);
                        const archive = mi.Invoke(null, [file]);
                        const entries = archive.Entries;
                        const e0 = entries.get_Item(0);
                        const st = e0.Open();
                        const reader = new Sys.IO.StreamReader(st, Sys.Text.Encoding.UTF8);
                        try { return String(reader.ReadToEnd()); } finally { try { reader.Dispose(); } catch (e) { } }
                    }
                    return String(Sys.IO.File.ReadAllText(file) || '');
                }

                // file=list -> 只列文件
                const wantFile = String(args.file || 'latest').trim();
                if (wantFile.toLowerCase() === 'list') {
                    const files = _listFiles();
                    return {
                        success: true, source: src, dir: _dir, count: files.length,
                        result: '历史日志文件（新的在前）:\n' + files.slice(0, 40).map(function (f) {
                            return '  ' + f.name + '  ' + (f.size ? Math.round(f.size / 1024) + 'KB' : '') + '  ' + f.mtime;
                        }).join('\n'),
                        files: files.slice(0, 40).map(function (f) { return f.name; }),
                        note: '查某一天: 把 file 设成日期(如 2026-10-01) 或完整文件名 ✓'
                    };
                }
                // 选文件: latest / 日期 / 完整文件名
                if (wantFile && wantFile.toLowerCase() !== 'latest') {
                    const files = _listFiles();
                    const exact = files.filter(function (f) { return f.name === wantFile; })[0];
                    const byDate = files.filter(function (f) { return f.name.indexOf(wantFile) === 0; })[0];
                    const hit = exact || byDate;
                    if (!hit) {
                        return {
                            success: false, source: src, file: wantFile,
                            available: files.slice(0, 12).map(function (f) { return f.name; }),
                            error: '找不到这个历史日志: ' + wantFile,
                            advice: '可用 file="list" 先看有哪些历史文件，或直接用日期(如 2026-10-01) ✓'
                        };
                    }
                    p = hit.full;
                }
                const all = _readText(p);
                const kw = util.trim(String(args.keyword || '')).toLowerCase();
                const lv = String(args.level || 'all').toLowerCase();
                let rows = all.split(/\r?\n/).filter(function (x) { return x; });
                // ★ 两种格式都要认: EasyBot 的 [ERR]/[WRN] 与 Minecraft 的 [Render thread/ERROR]、[Server thread/WARN]
                if (lv === 'error') {
                    rows = rows.filter(function (l) {
                        return /\[ERR\]|\[FTL\]|\/ERROR\]|\/FATAL\]|Exception|Caused by:|\bERROR\b/.test(l);
                    });
                } else if (lv === 'warn') {
                    rows = rows.filter(function (l) {
                        return /\[WRN\]|\[ERR\]|\[FTL\]|\/WARN\]|\/ERROR\]|\/FATAL\]|Exception|Caused by:|\bWARN\b|\bERROR\b/.test(l);
                    });
                }
                if (kw) rows = rows.filter(function (l) { return l.toLowerCase().indexOf(kw) >= 0; });
                const n = util.clamp(Number(args.lines) || 60, 1, 200);
                const tail = rows.slice(-n);
                return {
                    success: true,
                    source: src,
                    file: p,
                    totalLines: all.split(/\r?\n/).length,
                    matched: rows.length,
                    returned: tail.length,
                    text: tail.join('\n'),
                    note: tail.length
                        ? '以上是日志原始行。请据此判断"有没有报错/有没有执行"，不要在没看的情况下猜。'
                        : '没有匹配的日志行。可以换个更短的关键词，或把 level 改成 all 再看。'
                };
            } catch (e) {
                return { success: false, error: String((e && e.message) || e) };
            }
        }
    });

    // ---------------------------------------------------------------- DSH（DeepSeek Harness）
    // 模式①：模型自己决定调用；但【执行前必须管理员确认】✓
    registry.register({
        name: 'dsh_run',
        description: '【DSH 执行】把任务交给 DSH（跑在服务器宿主机上的执行助理，能读写文件、执行命令、查资料）。' +
            '★★ 这是【需要管理员确认】的工具：调用后【立刻】返回 code 和 requestId，管理员在群里回复「同意 <code>」后才会真正执行。' +
            '调用后请接着用 dsh_result(requestId) 取结果（返回 pending 就等几秒再试）。' +
            '★ 适合：需要在服务器上查文件 / 跑脚本 / 读日志做耗时排查这类"动手"的任务。' +
            '★ 不适合：普通聊天、查 MC 资料（那些用别的工具）。★ 不要假装已经执行，也不要拿它试探。',
        parameters: {
            type: 'object',
            properties: {
                task: { type: 'string', description: '交给 DSH 的任务：写清要做什么、在哪做、希望得到什么结果' }
            },
            required: ['task']
        },
        source: S,
        plugin: 'eb',
        qualify: false,
        handler: async function (args, ctx) {
            const c = dsh.cfg();
            if (!c.enabled) {
                return { success: false, error: 'DSH 未启用', advice: '不要调用本工具；直接告诉用户 DSH 还没开启。' };
            }
            if (!dsh.ready()) {
                return { success: false, error: dsh.notReadyReason(), advice: '不要调用本工具；告诉用户 DSH 还没配好。' };
            }
            const task = util.trim(args && args.task);
            if (!task) throw new Error('task 不能为空');

            const uid = String((ctx && ctx.senderId) || '');
            const name = String((ctx && ctx.senderName) || '');
            const req = dsh.createPending({ userId: uid, name: name, task: task });

            // 在【当前会话】里把确认请求发出去，管理员直接回「同意 <码>」
            try {
                await dsh.notify([
                    '🔐 【DSH 执行确认】',
                    '发起人：' + (name || '未知') + (uid ? '(' + uid + ')' : ''),
                    '任务：' + util.truncate(task.replace(/\s+/g, ' '), 180),
                    '管理员回复：同意 ' + req.code + '　/　拒绝 ' + req.code,
                    '（' + Math.round(c.approvalTimeoutSec) + ' 秒内有效；需权限 ≥ ' + c.approveMinLevel + '）'
                ].join('\n'));
            } catch (e) { }
            logger.info('[ai-chat] DSH 请求已创建: {0} 来自 {1}', req.code, uid);

            // 超时自动取消
            try {
                setTimeout(function () {
                    const cur = dsh.getPending(req.code);
                    if (cur && cur.status === 'pending') {
                        dsh.setPendingStatus(req.code, 'timeout', { error: '管理员未在 ' + Math.round(c.approvalTimeoutSec) + ' 秒内确认' });
                        if (cur.notify) { try { cur.notify('⌛ DSH 请求 ' + req.code + ' 超时未确认，已取消'); } catch (e) { } }
                        logger.info('[ai-chat] DSH 请求超时: {0}', req.code);
                    }
                }, Math.max(30, c.approvalTimeoutSec) * 1000);
            } catch (e) { }

            return {
                success: true,
                status: 'pending',
                code: req.code,
                requestId: req.id,
                note: '已提交管理员确认。请继续调用 dsh_result(requestId) 查询；pending 表示还没确认，等几秒再试。不要假装已经执行。'
            };
        }
    });

    // ---------------------------------------------------------------- 装 mod（交给 DSH 真装 + 管理员确认）
    registry.register({
        name: 'eb_install_mod',
        description: '【装 mod 到 MC 服】把用户刚发来的 .jar 装到指定服务器的 mods 目录（由 DSH 在宿主机上真装）。' +
            '★★ 需要管理员确认：调用后立刻返回 code，管理员回复「同意 <code>」才执行；之后用 dsh_result(requestId) 取结果。' +
            '★ 只能用【用户刚发给你的文件】或明确的 https 下载链接；不要自己编文件名或链接 ✗。' +
            '★ 默认只装不重启（restart=false）；重启会踢人，除非用户明确要求。' +
            '★★ 只要用户刚发过 .jar，就**直接调用本工具** ✓ —— 不要回答"我没有能力传文件/没有链接/装不了"✗，' +
            '那会骗人；工具的返回会告诉你到底缺什么（缺链接时才让它重发）✓。',
        parameters: {
            type: 'object',
            properties: {
                server: { type: 'string', description: '目标服务器名（必须是管理员配置过的）' },
                fileName: { type: 'string', description: '可选：说明是哪个文件（用于核对），一般不用填' },
                url: { type: 'string', description: '可选：https 下载直链（默认用用户刚发来的那个文件）' },
                restart: { type: 'boolean', description: '装完是否重启服务器（默认 false，会踢人）' }
            },
            required: ['server']
        },
        source: S,
        plugin: 'eb',
        qualify: false,
        handler: async function (args, ctx) {
            const c = dsh.cfg();
            if (!c.enabled || !dsh.ready()) {
                return { success: false, error: 'DSH 未启用/未就绪，装不了', advice: '告诉用户需要管理员手动装，或先开启 DSH。' };
            }
            const uid = String((ctx && ctx.senderId) || '');
            const name = String((ctx && ctx.senderName) || '');
            const server = String((args && args.server) || '').trim();
            // ★ 目标服由配置决定：tools.modInstallTargets = [{ server, modsDir, container }]
            const _tcfg = (config.get() || {}).tools || {};
            const targets = _tcfg.modInstallTargets || [];
            const SERVERS = {};
            for (let i = 0; i < targets.length; i++) {
                const t = targets[i] || {};
                if (t.server && t.modsDir) SERVERS[String(t.server)] = { dir: String(t.modsDir).replace(/\/mods\/?$/, ''), modsDir: String(t.modsDir), container: String(t.container || '') };
            }
            if (!Object.keys(SERVERS).length) {
                return { success: false, error: '没有配置可安装的服务器', advice: '请管理员在插件配置 tools.modInstallTargets 里登记（服务器名 + mods 目录）✓' };
            }
            if (!SERVERS[server]) return { success: false, error: '未配置这个服务器: ' + server + '（可选: ' + Object.keys(SERVERS).join(' / ') + '）' };
            const tgt = SERVERS[server];

            // 文件：优先参数里的 url，其次"这个人刚发来的文件"✓
            let f = null;
            try {
                const raw = litedb.Get('lastfile', uid);
                if (raw) f = JSON.parse(String(raw));
            } catch (e) { }
            const givenUrl = String((args && args.url) || '').trim();
            let url = givenUrl || (f && f.url) || '';
            // ★ 显式给了 url 时，文件名从 url 取（别再拿缓存里旧文件名 ✗）
            let urlName = '';
            try {
                // ★ QQ 的直链文件名在 ?fname= 里（路径末尾常常是个没扩展名的 handler id ✗）
                const _fn = String(url).match(/[?&]fname=([^&#]+)/i);
                if (_fn) urlName = decodeURIComponent(_fn[1]);
                if (!urlName) {
                    const _path = String(url).replace(/^[a-z]+:\/\/[^\/]*/i, '').split('?')[0].split('#')[0];
                    urlName = decodeURIComponent(_path.split('/').pop() || '');
                }
            } catch (e) { }
            // ★ url 里取不到名字时（QQ 直链常见 ?fname= 为空 ✗）→ 回退用缓存里的文件名 ✓
            let fname = String((args && args.fileName) || '').trim() || urlName || ((f && f.name) || '');
            if (!url || !/^https:\/\//i.test(url)) {
                return { success: false, error: '没有可用的下载链接', advice: '请让用户重新发送那个 .jar 文件（或给一个 https 直链）后再试。' };
            }
            // ★ 只允许 QQ 文件 CDN，防止被引导去下载任意东西 ✗
            const HOST_OK = /(^|\.)(njc-download\.ftn\.qq\.com|multimedia\.nt\.qq\.com\.cn|gchat\.qpic\.cn|qq\.com|myqcloud\.com)$/i;
            let host = '';
            try { const _m = String(url).match(/^https?:\/\/([^\/:?#]+)/i); host = _m ? String(_m[1]).toLowerCase() : ''; } catch (e) { }
            if (!HOST_OK.test(host)) return { success: false, error: '下载链接域名不允许: ' + host, advice: '只能用 QQ 文件直链或让用户重发文件。' };
            // 文件名消毒（只取 basename，防目录穿越 ✗）
            fname = String(fname || '').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._\-+]/g, '_');
            if (!/\.jar$/i.test(fname)) return { success: false, error: '只支持 .jar（当前: ' + (fname || '未知') + '）' };

            // ★ 先把文件下载到【宿主机也能看到】的目录（/app/logs 是 rw 挂载 ✓），再把本地路径交给 DSH ✓
            //   好处：不依赖 QQ 临时链接（几小时就失效 ✗）
            let localHostPath = '';
            const upHost = String(((config.get() || {}).tools || {}).uploadHostDir || '');
            if (upHost) {
                try {
                    const Sys = Function('return (typeof dotnet !== "undefined") ? dotnet.System : null')();
                    const dir = '/app/logs/uploads';
                    try { if (Sys && !Sys.IO.Directory.Exists(dir)) Sys.IO.Directory.CreateDirectory(dir); } catch (e) { }
                    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const fileName2 = stamp + '_' + fname;
                    const localPath = dir + '/' + fileName2;
                    // ★ byte[] 直传宿主不行，WebClient.DownloadFile 可以 ✓（以前解压 zip 时验证过）
                    // ★ 宿主里没有 Sys.Net.WebClient ✗（实测 "Cannot read properties of undefined"）
                    //   已验证可行的写法：反射加载 System.Net 再 new WebClient ✓
                    const nasm = Sys.Reflection.Assembly.Load('System.Net');
                    const WebClientT = nasm.GetType('System.Net.WebClient');
                    const wc = Sys.Activator.CreateInstance(WebClientT);
                    wc.DownloadFile(url, localPath);
                    const fi = Sys.Activator.CreateInstance(Sys.IO.FileInfo, localPath);
                    if (Number(fi.Length) > 0) {
                        localHostPath = upHost.replace(/\/+$/, '') + '/' + fileName2;
                        logger.info('[ai-chat] 装 mod：文件已落盘 {0} ({1} 字节)', localHostPath, Number(fi.Length));
                    }
                } catch (e) {
                    const msg = String((e && e.message) || e);
                    logger.warning('[ai-chat] 装 mod 前落盘失败: {0}', msg);
                    // ★ QQ 直链会过期（403/404）→ 让用户重发文件，别把死链接交给 DSH ✗
                    if (/\b403\b|\b404\b|Forbidden|Not Found/.test(msg)) {
                        return { success: false,
                            error: '这个文件的下载链接已经过期了（' + msg.replace(/^.*?error:?\s*/i, '').slice(0, 60) + '）',
                            advice: '让用户【重新发一次那个 .jar 文件】，然后马上再说「装到某服」✓（QQ 的文件链接几小时就会失效）' };
                    }
                }
            }
            const task = [
                '【任务：安装 Minecraft mod 到指定服务器】',
                '目标服务器：' + server + '（数据目录 ' + tgt.dir + '，容器名 ' + tgt.container + '）',
                (localHostPath ? ('jar 已在宿主机（直接用它，别联网重下）：' + localHostPath) : ('jar 下载地址：' + url)),
                '文件名：' + fname,
                '',
                '请严格按步骤做，最后用 3~6 行中文汇报（不要贴大段日志）:',
                (localHostPath
                    ? ('1) 直接复制到 /tmp/' + fname + '（cp，不用联网），并用 python3 校验它是合法 zip 且含 fabric.mod.json 或 META-INF/mods.toml；不是就停止并说明')
                    : ('1) 下载到 /tmp/' + fname + '（curl -fL --max-time 180），并用 python3 校验它是合法 zip 且含 fabric.mod.json 或 META-INF/mods.toml；不是就停止并说明')),
                '2) 读出它的 depends.minecraft，并与服务器实际版本比较（版本从 ' + tgt.dir + '/logs/latest.log 的 "Loading Minecraft X with Fabric Loader Y" 取）；不兼容就停止并说明',
                '3) 若 ' + tgt.modsDir + '/ 下已有同名 jar，先改名成 同名.bak-时间戳',
                '4) 用 root 一次性容器复制进 mods 并 chmod 755：',
                '   docker run --rm -u 0 -v ' + (tgt.modsDir.split('/').slice(0,2).join('/')) + ':' + (tgt.modsDir.split('/').slice(0,2).join('/')) + ' -v /tmp:/hosttmp alpine:latest sh -c "cp /hosttmp/' + fname + ' ' + tgt.modsDir + '/' + fname + ' && chmod 755 ' + tgt.modsDir + '/' + fname + '"',
                '5) ls 一下 ' + tgt.modsDir + '/ 确认该 jar 存在，汇报大小',
                (args && args.restart === true
                    ? '6) 重启服务器：docker restart ' + tgt.container + '（用户明确要求了重启，会踢人）；重启后从日志确认新版本已加载'
                    : '6) 【不要重启服务器】。只在汇报里注明"已放入 mods，重启后生效"'),
                '',
                '硬性限制：不要改任何 config/配置、不要删别的 jar、不要动其它插件、不要装到别的服务器 ✗'
            ].join('\n');

            const req = dsh.createPending({ userId: uid, name: name, task: task });
            try {
                await dsh.notify([
                    '🔐 【装 mod 确认】',
                    '发起人：' + (name || '未知') + (uid ? '(' + uid + ')' : ''),
                    '目标：' + server + '　文件：' + fname,
                    (args && args.restart === true) ? '⚠ 包含重启服务器' : '装完不重启（重启后生效）',
                    '管理员回复：同意 ' + req.code + '　/　拒绝 ' + req.code,
                    '（' + Math.round(c.approvalTimeoutSec) + ' 秒内有效；需权限 ≥ ' + c.approveMinLevel + '）'
                ].join('\n'));
            } catch (e) { }
            logger.info('[ai-chat] 装 mod 请求已创建: {0} 目标={1} 文件={2} 来自 {3}', req.code, server, fname, uid);
            try {
                setTimeout(function () {
                    const cur = dsh.getPending(req.code);
                    if (cur && cur.status === 'pending') {
                        dsh.setPendingStatus(req.code, 'timeout', { error: '管理员未在 ' + Math.round(c.approvalTimeoutSec) + ' 秒内确认' });
                        if (cur.notify) { try { cur.notify('⌛ 装 mod 请求 ' + req.code + ' 超时未确认，已取消'); } catch (e) { } }
                    }
                }, Math.max(30, c.approvalTimeoutSec) * 1000);
            } catch (e) { }
            return {
                success: true, status: 'pending', code: req.code, requestId: req.id,
                note: '已提交管理员确认（同意 ' + req.code + '）。之后用 dsh_result(requestId) 取结果；不要假装已经装好 ✗'
            };
        }
    });

    registry.register({
        name: 'dsh_result',
        description: '查询 dsh_run 提交的 DSH 任务结果。status 可能是：pending(等管理员确认) / running(执行中) / ' +
            'done(完成，看 result) / rejected(被拒) / timeout(确认超时) / error。传 dsh_run 返回的 requestId 或 code。',
        parameters: {
            type: 'object',
            properties: {
                requestId: { type: 'string', description: 'dsh_run 返回的 requestId（也接受确认码 code）' }
            },
            required: ['requestId']
        },
        source: S,
        plugin: 'eb',
        qualify: false,
        handler: async function (args) {
            const key = util.trim(String((args && args.requestId) || ''));
            if (!key) throw new Error('requestId 不能为空');
            const req = dsh.findPending(key);
            if (!req) {
                return { success: false, error: '没有这个 DSH 请求（可能已完成并被清理，或码写错了）' };
            }
            if (req.status === 'pending') {
                return { success: true, status: 'pending', code: req.code, note: '还在等管理员确认，等几秒再查；不要催用户。' };
            }
            if (req.status === 'running') {
                return { success: true, status: 'running', code: req.code, note: '管理员已同意，DSH 正在执行，等几秒再查。' };
            }
            if (req.status === 'done') {
                return { success: true, status: 'done', code: req.code, workspace: req.cwd || undefined,
                    result: dsh.brief(req.text, 3000), note: '这是 DSH 的输出，请用自己的话简要转述给用户。' };
            }
            return {
                success: false,
                status: req.status,
                code: req.code,
                error: req.error || ('DSH 未完成：' + req.status),
                advice: req.status === 'rejected' ? '告诉用户管理员拒绝了这次执行，可以问问他为什么。'
                    : (req.status === 'timeout' ? '告诉用户管理员没及时确认，超时取消了。' : '把错误如实告诉用户。')
            };
        }
    });

    registry.register({
        name: 'eb_search_wiki',
        description: '查询 Minecraft Wiki 的原版指令写法。**只在 eb_find_command 也找不到时才用**。' +
            '★★ 默认查的是【中文站 zh.minecraft.wiki】✓ —— 所以关键词请用【中文名】' +
            '(写「潜影贝」✓ 不要写「shulker」✗, 写「侦测器」✓ 不要写「observer」✗); ' +
            '用中文名查询的命中率明显更高。搜索词要短(2~4 个词), 别堆一长串。' +
            '返回的是原版参考, 本服可能装了模组改过指令(例如白名单要用 easywhitelist), ' +
            '所以必须明确告诉用户"这是 Wiki 的原版写法", 且不要直接拿它执行会改变服务器状态的指令。',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '要查询的关键词, 例如: 白名单 / 传送 / 记分板 / gamerule' },
                source: { type: 'string', description: 'Wiki 名称, 可省略(用配置里的第一个)' }
            },
            required: ['query']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const q = util.trim(args.query);
            if (!q) throw new Error('查询关键词不能为空');
            let res;
            try {
                res = await wiki.lookup(q, { source: util.trim(args.source) || null });
            } catch (e) {
                const msg = String((e && e.message) || e);
                // 实测: 中英文 Minecraft Wiki 都会对插件的请求返回反爬挑战页, 因为
                // EasyBot 的 network API 发不了自定义 User-Agent。这种情况要说清楚,
                // 别让模型反复重试, 直接回到本服知识库。
                const challenge = /不是 JSON|Please wait|403|Forbidden|Unexpected token|<!DOCTYPE|<html/i.test(msg);
                logger.warning('[ai-chat] Wiki 查询失败: {0}', util.truncate(msg, 160));
                return {
                    success: false,
                    wikiBlocked: challenge,
                    error: msg,
                    advice: challenge
                        ? 'Wiki 拒绝了这次请求(反爬/无法设置请求头)。别再试了, 改回本服指令知识库; ' +
                          '如果知识库里确实没有, 就直接告诉用户"本服没查到这条指令, 请管理员补进指令知识库"。'
                        : 'Wiki 暂时查不到, 可以换关键词再试一次, 或回到本服知识库。'
                };
            }
            if (res.ok === false) return { success: false, error: res.error, advice: '回到本服指令知识库。' };
            logger.info('[ai-chat] Wiki 查询 "{0}" -> {1} 条结果', q, (res.results || []).length);
            return {
                success: true,
                query: q,
                source: res.source,
                found: (res.results || []).length,
                result: wiki.render(res),
                results: res.results,
                detailTitle: res.detailTitle,
                caution: res.note
            };
        }
    });

    registry.register({
        name: 'memory_save',
        description: '把值得长期记住的信息写入记忆(用户称呼、喜好、约定、身份等)。scope=user 只对这个用户生效, session 对本会话生效, global 全局生效。',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: '要记住的一句话, 例如"小明喜欢红石, 是服务器老玩家"' },
                scope: { type: 'string', enum: ['user', 'session', 'global'], description: '记忆作用范围, 默认 user' }
            },
            required: ['text']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args, ctx) {
            const scope = ['user', 'session', 'global'].indexOf(String(args.scope)) >= 0 ? String(args.scope) : 'user';
            const fact = memory.addFact(args.text, {
                scope: scope,
                owner: ctx && ctx.senderId,
                session: ctx && ctx.sessionKey
            });
            if (!fact) throw new Error('记忆内容为空');
            return { success: true, id: fact.id, scope: fact.scope, text: fact.text };
        }
    });

    registry.register({
        name: 'memory_search',
        description: '在长期记忆中搜索相关内容。',
        parameters: {
            type: 'object',
            properties: { keyword: { type: 'string', description: '搜索关键词, 留空则返回最近的记忆' } },
            required: []
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const list = memory.searchFacts(args.keyword, 10);
            return { count: list.length, memories: list.map(function (f) { return { id: f.id, text: f.text, scope: f.scope }; }) };
        }
    });

    registry.register({
        name: 'memory_forget',
        description: '删除一条长期记忆(需要记忆 id, 可由 memory_search 获取)。',
        parameters: {
            type: 'object',
            properties: { id: { type: 'string', description: '记忆 id' } },
            required: ['id']
        },
        source: S, plugin: 'eb', qualify: false,
        handler: async function (args) {
            const ok = memory.forgetFact(args.id);
            return { success: ok };
        }
    });
}

/** 重新注册 eb_run_command, 让工具描述里的指令知识库保持最新 */
function refreshCommandTool() {
    try {
        if (registry.get('eb_run_command')) {
            registry.unregister('eb_run_command');
            registerAll();
        }
    } catch (e) { /* ignore */ }
}

module.exports = {
    registerAll: registerAll,
    refreshCommandTool: refreshCommandTool,
    checkCommand: checkCommand,
    cleanOutput: cleanOutput,
    resolveExecutor: resolveExecutor,
    isPlayerOnline: isPlayerOnline,
    shouldUsePapi: shouldUsePapi,
    pickAdapter: pickAdapter,
    listServers: listServers,
    resolveServer: resolveServer,
    checkCommand: checkCommand,
    plain: plain
};
