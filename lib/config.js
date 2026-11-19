'use strict';

/**
 * 配置模块。
 *
 * 配置来源优先级 (后者覆盖前者):
 *   1. 本文件的 DEFAULT_CONFIG
 *   2. 插件目录下的 config.json (若存在且 archive API 可用)
 *   3. EasyBot 配置分组 "main" 中用户保存的值 (config.getConfigObject("main"))
 *
 * 支持三种用户配置写法, 都会尽量映射到 DEFAULT_CONFIG 的层级结构:
 *   A. 层级式:  { "llm": { "apiKey": "sk-xxx" } }
 *   B. 点号式:  { "llm.apiKey": "sk-xxx" }
 *   C. 扁平式:  { "apiKey": "sk-xxx" }   (通过 ALIAS 映射)
 */

const util = require('./util.js');

const DEFAULT_CONFIG = {
    llm: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        summaryModel: '',
        temperature: 0.9,
        maxTokens: 800,
        timeoutMs: 60000,
        maxToolRounds: 3,
        apiStyle: 'tools',
        authMode: 'header',
        authQueryParam: 'api_key',
        selfTestOnEnable: false,
        selfTestPrompt: '你好，请用一句话介绍你自己',
        rateLimitCooldownSec: 60,
        // 通用代理: 留空=直连(要求接口不强制 Content-Type: application/json);
        // 填了就把请求交给本机转发, 由它补 Content-Type。换供应商只需改上面的 baseUrl。
        relayBase: '',
        extraHeaders: {}
    },
    persona: {
        name: '小助手',
        identity: '你是一名 Minecraft 服务器玩家群里的老群友, 同时也是服务器里的助手',
        personality: '性格温和、幽默、有耐心, 偶尔吐槽但从不刻薄, 会对熟人更随意一些',
        speakingStyle: '说话口语化、简短, 像真人在 QQ 里聊天, 经常把一句话拆成两三条发, 不用 Markdown, 不列 1234 条要点',
        background: '',
        extraRules: '',
        exampleDialogue: ''
    },
    behavior: {
        enabled: true,
        // 用户"手动执行指令"的消息前缀(命中后不让 AI 再重复执行)
        manualCommandPrefixes: '！,!,/',
        // 命中后的行为: no-tools(仍可回复但不给工具) | skip(完全不回) | off(不处理)
        manualCommandAction: 'no-tools',
        nameTrigger: true,
        replyTrigger: true,
        replyToDirect: true,
        groupMode: 'mention',
        randomChance: 0.05,
        mentionNames: [],
        prefixes: ['ai', 'AI'],
        keywords: [],
        recordAllGroupMessages: true,
        // ★ 忽略规则: 每行一个正则; 命中就只记录上下文, 不接话(给别的插件让路)
        //   ⚠️ 这里只是【兜底】。真正权威的是下面那个"兄弟插件认领"接口 ——
        //   实测教训: 快递插件支持了"发给"这种说法, 本列表里的正则没跟上,
        //   结果同一条消息被两个插件各处理一遍(还白烧了 110 秒) ✗
        ignorePatterns: '',
        // ★★ 兄弟插件(离线物品寄送)的"认领"接口: 调模型之前先问它"这条归你处理吗?"
        //    是 -> 我就不接话。判定在对方插件里(唯一权威), 所以永远不会漂移 ✓
        //    留空 = 关掉这个机制; 超时/报错一律按"不是它的"处理(fail-open) ✓
        itemMailClaimUrl: 'http://127.0.0.1:18888/tool/claim',
        itemMailClaimTimeoutMs: 400,
        continuationWindowSec: 150,
        continuationAnyone: false,
        cooldownSec: 3,
        maxRepliesPerMinute: 8,
        maxConcurrent: 3,
        // ★ 默认 false: 不给模型"可以不回"的选项 —— 被叫到(或触发)就必须回,
        //   实测踩过: 开着的时候模型会自己判"不需要插话" -> 叫它也不理人 ✗
        allowSkip: false,
        skipToken: '[SKIP]',
        notifyWhenUnconfigured: false,
        maxInputChars: 1500
    },
    humanize: {
        enabled: true,
        typingBaseMs: 400,
        typingPerCharMs: 45,
        typingJitterMs: 600,
        typingMaxMs: 6000,
        multiSegment: true,
        splitOnNewline: true,     // 模型写的换行 = 分段(一行一条消息)
        segmentMaxChars: 120,
        segmentMaxCount: 4,
        segmentDelayBaseMs: 350,
        segmentDelayPerCharMs: 25,
        segmentDelayJitterMs: 350,
        quoteChance: 0.25,
        atChance: 0.2,
        emojiChance: 0.15,
        emojiIds: [1, 4, 5, 9, 14, 21, 76]
    },
    vision: {
        enabled: false,
        maxImages: 2,
        includeSticker: false,
        lookbackSeconds: 180,
        describeOnReceive: false,
        describePrompt: '请用中文简要描述这张图片的内容, 如果有文字也概括出来, 输出一段不超过100字的平文本, 不要分点',
        selfTestRounds: 2,
        // 可填多张(逗号/换行分隔), 逐个试, 提高自检成功率
        selfTestImageUrl: ''
    },
    memory: {
        historyMode: 'context',
        maxMessages: 24,
        maxChars: 6000,
        maxFactsPerUser: 12,
        autoSummaryEvery: 10,
        contextTtlHours: 72
    },
    debug: {
        logMcMessages: false
    },
    access: {
        adminUserIds: [],
        allowGroupIds: [],
        denyGroupIds: [],
        allowDirectUserIds: [],
        denyDirectUserIds: []
    },
    permissions: {
        enabled: true,
        defaultLevel: 0,        // 普通群友默认最低等级
        groupOwnerLevel: 3,     // 群主 = 最高
        groupAdminLevel: 0,     // 群管理默认也是最低(需要就单独给)
        groupScopes: '',        // 按群分类: 每行 "群号 | QQ:等级, QQ:等级"
        userLevels: '',         // 全局(不限群): "QQ:等级, QQ:等级"
        users: {},
        safeLevel: 1,
        mediumLevel: 2,
        unknownCommandLevel: 3,
        safeCommands: ['list', 'tps', 'mspt', 'time query', 'weather query', 'who', 'online',
            'seed', 'me', 'say', 'tell', 'msg', 'w', 'help', 'difficulty'],
        mediumCommands: []
    },
    commands: {
        enabled: true,
        prefix: '/ai'
    },
    // ---------------------------------------------------------------- DSH（DeepSeek Harness）接入
    // ★ 默认关闭：开了就等于把宿主机的"执行能力"接进群聊，务必先配好令牌和权限 ✓
    //   宿主机需要先跑 dsh-bridge（见仓库里的 dsh-bridge 目录），插件通过 HTTP 调它。
    //   baseUrl 用"容器能访问到的宿主机地址"：docker 默认网桥网关，如 http://127.0.0.1:18990 ✓
    dsh: {
        enabled: false,
        baseUrl: '',
        token: '',
        cwd: '',                    // 留空=用桥接服务的默认工作目录
        timeoutMs: 200000,          // 单次执行超时
        maxReplyChars: 800,         // 回群里的"简要输出"长度
        forwardAsMerge: true,       // 输出用合并转发（宿主 SDK 不支持时自动回退为长文本）
        outputMode: 'auto',         // auto(合并→图片→文本) / merge / image / text
        // 图片输出（不能合并转发时，把长输出渲染成图；背景/字体都可配）
        image: {
            enabled: true,
            background: '',
            backgroundColor: '#17171c',
            width: 760,
            padding: 30,
            fontFamily: '"Microsoft YaHei","Noto Sans CJK SC","PingFang SC",sans-serif',
            fontSize: 22,
            lineHeight: 1.7,
            color: '#e9e9ee',
            titleColor: '#8ab4f8',
            titleSize: 26,
            maxCharsPerImage: 1500,
            maxImages: 3,
            timeoutSec: 30,
            template: '',
            uriMode: 'base64',
        },
        approveMinLevel: 3,         // ① 工具模式：谁能批准执行（权限等级）
        approvalTimeoutSec: 180,    // ① 等确认的超时
        modeMinLevel: 3,            // ② 谁能进入 DSH 模式
        modeIdleTimeoutSec: 1800,   // ② 空闲自动退出（秒，0=不自动）
    },
    tools: {
        enabled: true,
        maxResultChars: 3000,
        timeoutMs: 15000,
        allowRunCommand: true,
        defaultServerToken: '',
        allowSendMessage: false,
        // ★ 读日志(eb_read_log)所需的最低权限等级: 3=高危指令(≈管理员)。日志含玩家名/聊天/令牌, 别放开 ✗
        logReadMinLevel: 3,
        // ★ 带文件的一轮: 文件内容是不可信数据(可能是提示词注入), 物理撤掉"会动东西"的工具 ✗
        fileGuard: ['eb_run_command', 'item_mail_transfer', 'dsh_run', 'eb_install_mod'],
        // 日志来源（eb_read_log 的 source）：[{key, name, paths:[...]}]，默认只有 easybot 自己的日志 ✓
        logSources: [],
        // 允许"装 mod"的服务器：[{server, modsDir, container}]，留空 = 该功能不可用 ✓
        modInstallTargets: [],
        // 装 mod 时把文件先落到"宿主机也能看到"的目录（容器内 /app/logs/uploads 对应的宿主机路径）；
        // 留空 = 不落盘，直接把 QQ 下载链接交给 DSH ✓
        uploadHostDir: '',
        // 兄弟插件(快递)认领过这条时，撤掉这些工具（避免同一条被处理两遍 ✗）
        siblingGuard: ['item_mail_transfer'],
        // ★ 这些工具在"用户引用/回复某条消息"触发时会被撤掉(内容可能不是他这次的意思),
        //   让模型只能先问清楚, 不能直接动手。按工具名子串匹配。
        quoteGuard: ['item_mail_transfer'],
        proactiveAllowedGroups: [],
        consoleName: 'CONSOLE',
        runAsBoundPlayer: true,     // 优先以"请求者绑定的 MC 玩家"身份执行(官方推荐做法)
        enablePapi: true,           // 执行指令时是否让服务端解析 %player_name% 等 PAPI 变量
        papiOnlyWhenOnline: true,   // 只在执行者在线时才开 PAPI (离线时模组会把指令改坏, 见下)
        // 执行身份策略: bound=只用绑定玩家 | boundIfOnline=绑定玩家在线就用他, 否则用 consoleName
        //              | console=固定用 consoleName
        executorMode: 'bound',
        commandHints: '',           // (旧字段, 仍兼容) 本服可用指令清单
        // 指令知识库: 每行 "指令 | 说明 | 关键词(逗号分隔) | 需要等级"
        commandBook: '',
        commandBookInDescription: 8,  // 有多少条指令会写进 eb_run_command 的工具描述
        // Wiki 兜底查询(知识库里找不到时才用; 只走 MediaWiki 官方 API)
        // 玩家存档数据查询(离线也能查, 走 bridge 的 ReadNbtData)
        playerData: { enabled: true, minLevel: 1, maxItems: 60 },
        wiki: {
            enabled: false,
            endpoints: 'Minecraft Wiki(中文) | https://zh.minecraft.wiki/api.php',
            deepFetch: true,
            maxResults: 3,
            maxChars: 1500,
            timeoutMs: 25000
        },
        // 自然语言 -> 本服指令 的专用规则(每行: 工具名|标题|指令模板|参数|等级)
        commandRules: '',
        // 指令改写(每行: 正则=替换), 例如 ^whitelist\b=easywhitelist
        commandRewrites: '',
        allowPlayerCommand: false,
        commandBlacklist: ['stop', 'op', 'deop', 'ban', 'ban-ip', 'pardon', 'kick', 'whitelist', 'reload', 'restart', 'save-off', 'save-all'],
        gateway: {
            enabled: true,
            host: '127.0.0.1',
            port: 20777,
            token: '',
            allowRemote: false
        },
        discover: {
            enabled: true,
            pluginsDir: ''
        },
        httpTools: [],
        bridgeTools: []
    }
};

/** 扁平字段名 -> 配置路径 的映射 (兼容 UI 表单直接平铺保存的情况) */
const ALIAS = {
    apikey: 'llm.apiKey',
    api_key: 'llm.apiKey',
    key: 'llm.apiKey',
    baseurl: 'llm.baseUrl',
    api_base: 'llm.baseUrl',
    model: 'llm.model',
    summarymodel: 'llm.summaryModel',
    temperature: 'llm.temperature',
    maxtokens: 'llm.maxTokens',
    timeoutms: 'llm.timeoutMs',
    selftestonenable: 'llm.selfTestOnEnable',
    authmode: 'llm.authMode',
    authqueryparam: 'llm.authQueryParam',
    apistyle: 'llm.apiStyle',
    name: 'persona.name',
    botname: 'persona.name',
    identity: 'persona.identity',
    personality: 'persona.personality',
    speakingstyle: 'persona.speakingStyle',
    background: 'persona.background',
    personaname: 'persona.name',
    extrarules: 'persona.extraRules',
    visionenabled: 'vision.enabled',
    maximages: 'vision.maxImages',
    includesticker: 'vision.includeSticker',
    lookbackseconds: 'vision.lookbackSeconds',
    describeonreceive: 'vision.describeOnReceive',
    describeprompt: 'vision.describePrompt',
    selftestprompt: 'llm.selfTestPrompt',
    ratelimitcooldownsec: 'llm.rateLimitCooldownSec',
    relaybase: 'llm.relayBase',
    selftestimageurl: 'vision.selfTestImageUrl',
    selftestrounds: 'vision.selfTestRounds',
    humanizeenabled: 'humanize.enabled',
    groupmode: 'behavior.groupMode',
    randomchance: 'behavior.randomChance',
    prefixes: 'behavior.prefixes',
    keywords: 'behavior.keywords',
    mentionnames: 'behavior.mentionNames',
    humanize: 'humanize.enabled',
    port: 'tools.gateway.port',
    token: 'tools.gateway.token',
    allowruncommand: 'tools.allowRunCommand',
    allowsendmessage: 'tools.allowSendMessage',
    defaultservertoken: 'tools.defaultServerToken',
    proactiveallowedgroups: 'tools.proactiveAllowedGroups',
    commandblacklist: 'tools.commandBlacklist',
    toolsenabled: 'tools.enabled',
    gatewayenabled: 'tools.gateway.enabled',
    gatewayport: 'tools.gateway.port',
    gatewaytoken: 'tools.gateway.token',
    typingpercharms: 'humanize.typingPerCharMs',
    segmentmaxchars: 'humanize.segmentMaxChars',
    segmentmaxcount: 'humanize.segmentMaxCount',
    cooldownsec: 'behavior.cooldownSec',
    maxrepliesperminute: 'behavior.maxRepliesPerMinute',
    adminuserids: 'access.adminUserIds',
    allowgroupids: 'access.allowGroupIds',
    denygroupsids: 'access.denyGroupIds',
    denygroupids: 'access.denyGroupIds',
    // ---- 其余表单字段名(兼容"扁平保存"与"分组容器保存"两种形态) ----
    replytodirect: 'behavior.replyToDirect',
    behaviorenabled: 'behavior.enabled',
    permissionsenabled: 'permissions.enabled',
    logmcmessages: 'debug.logMcMessages',
    defaultlevel: 'permissions.defaultLevel',
    groupownerlevel: 'permissions.groupOwnerLevel',
    groupadminlevel: 'permissions.groupAdminLevel',
    userlevels: 'permissions.userLevels',
    groupscopes: 'permissions.groupScopes',
    safelevel: 'permissions.safeLevel',
    mediumlevel: 'permissions.mediumLevel',
    unknowncommandlevel: 'permissions.unknownCommandLevel',
    safecommands: 'permissions.safeCommands',
    mediumcommands: 'permissions.mediumCommands',
    nametrigger: 'behavior.nameTrigger',
    manualcommandprefixes: 'behavior.manualCommandPrefixes',
    manualcommandaction: 'behavior.manualCommandAction',
    replytrigger: 'behavior.replyTrigger',
    recordallgroupmessages: 'behavior.recordAllGroupMessages',
    ignorepatterns: 'behavior.ignorePatterns',
    continuationwindowsec: 'behavior.continuationWindowSec',
    continuationanyone: 'behavior.continuationAnyone',
    maxconcurrent: 'behavior.maxConcurrent',
    allowskip: 'behavior.allowSkip',
    maxinputchars: 'behavior.maxInputChars',
    skiptoken: 'behavior.skipToken',
    notifywhenunconfigured: 'behavior.notifyWhenUnconfigured',
    typingbasems: 'humanize.typingBaseMs',
    typingjitterms: 'humanize.typingJitterMs',
    typingmaxms: 'humanize.typingMaxMs',
    multisegment: 'humanize.multiSegment',
    splitonnewline: 'humanize.splitOnNewline',
    segmentdelaybasems: 'humanize.segmentDelayBaseMs',
    segmentdelaypercharms: 'humanize.segmentDelayPerCharMs',
    segmentdelayjitterms: 'humanize.segmentDelayJitterMs',
    quotechance: 'humanize.quoteChance',
    atchance: 'humanize.atChance',
    emojichance: 'humanize.emojiChance',
    emojiids: 'humanize.emojiIds',
    maxmessages: 'memory.maxMessages',
    historymode: 'memory.historyMode',
    maxchars: 'memory.maxChars',
    maxfactsperuser: 'memory.maxFactsPerUser',
    autosummaryevery: 'memory.autoSummaryEvery',
    contextttlhours: 'memory.contextTtlHours',
    toolstimeoutms: 'tools.timeoutMs',
    maxresultchars: 'tools.maxResultChars',
    consolename: 'tools.consoleName',
    runasboundplayer: 'tools.runAsBoundPlayer',
    enablepapi: 'tools.enablePapi',
    papionlywhenonline: 'tools.papiOnlyWhenOnline',
    executormode: 'tools.executorMode',
    commandhints: 'tools.commandHints',
    commandbook: 'tools.commandBook',
    commandbookindescription: 'tools.commandBookInDescription',
    wikienabled: 'tools.wiki.enabled',
    wikiendpoints: 'tools.wiki.endpoints',
    wikideepfetch: 'tools.wiki.deepFetch',
    wikimaxresults: 'tools.wiki.maxResults',
    wikimaxchars: 'tools.wiki.maxChars',
    commandrules: 'tools.commandRules',
    commandrewrites: 'tools.commandRewrites',
    allowplayercommand: 'tools.allowPlayerCommand',
    gatewayhost: 'tools.gateway.host',
    gatewayallowremote: 'tools.gateway.allowRemote',
    discoverenabled: 'tools.discover.enabled',
    pluginsdir: 'tools.discover.pluginsDir',
    commandsenabled: 'commands.enabled',
    commandprefix: 'commands.prefix',
    allowdirectuserids: 'access.allowDirectUserIds',
    denydirectuserids: 'access.denyDirectUserIds'
};

/** 动态表单里的"容器分组 id" -> 配置区块名 */
const GROUP_SECTION = {
    llmgroup: 'llm',
    personagroup: 'persona',
    triggergroup: 'behavior',
    humangroup: 'humanize',
    memorygroup: 'memory',
    commandgroup: 'commands',
    toolgroup: 'tools',
    accessgroup: 'access'
};

/** 本插件认识的配置区块 */
const SECTIONS = ['llm', 'persona', 'behavior', 'humanize', 'memory', 'access', 'commands', 'tools'];

/** 这些字段如果以逗号字符串出现, 应转成数组 */
const LIST_KEYS = ['prefixes', 'keywords', 'mentionnames', 'commandblacklist', 'emojiids',
    'adminuserids', 'allowgroupids', 'denygroupids', 'allowdirectuserids', 'denydirectuserids'];

/** 按路径写值 */
function setByPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
        cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
}

/** 按路径取值 */
function getByPath(obj, path, def) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return def;
        cur = cur[parts[i]];
    }
    return cur === undefined ? def : cur;
}

/** 递归合并 source(用户配置) 到 target(默认配置) */
function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    Object.keys(source).forEach(function (k) {
        const v = source[k];
        if (v === undefined) return;
        if (Array.isArray(v)) { target[k] = v; return; }
        if (v !== null && typeof v === 'object') {
            if (typeof target[k] !== 'object' || target[k] === null || Array.isArray(target[k])) target[k] = {};
            deepMerge(target[k], v);
            return;
        }
        // 类型保护: 默认值是数字而用户给的是数字字符串时做转换
        if (typeof target[k] === 'number' && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
            target[k] = Number(v);
            return;
        }
        if (typeof target[k] === 'boolean' && typeof v === 'string') {
            target[k] = (v === 'true' || v === '1' || v === 'on' || v === 'yes');
            return;
        }
        target[k] = v;
    });
    return target;
}

/**
 * 把用户配置规整成 DEFAULT_CONFIG 的层级结构。
 *
 * EasyBot 的动态表单在不同版本/保存方式下可能给出不同形态, 这里全部兼容:
 *   层级式     { llm: { apiKey: "x" } }
 *   点号式     { "llm.apiKey": "x" }
 *   扁平式     { apiKey: "x" }
 *   分组容器式 { llmGroup: { apiKey: "x" } }   <- 表单按 ContainerGroup 保存时是这样
 *
 * @param {object} raw 原始配置
 * @param {object} [out] 累积结果
 * @param {string} [sectionHint] 当前所处的配置区块(由容器分组推导)
 */
function normalizeUserConfig(raw, out, sectionHint) {
    out = out || {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

    Object.keys(raw).forEach(function (k) {
        const v = raw[k];
        const lower = String(k).toLowerCase();

        // ---- 嵌套对象 ----
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            const byGroup = GROUP_SECTION[lower];
            if (byGroup) { normalizeUserConfig(v, out, byGroup); return; }
            if (SECTIONS.indexOf(lower) >= 0) { normalizeUserConfig(v, out, lower); return; }
            if (sectionHint) { normalizeUserConfig(v, out, sectionHint); return; }
            out[k] = v;                        // 不认识的嵌套对象原样保留
            return;
        }

        // ---- 点号路径 ----
        if (k.indexOf('.') > 0) { setByPath(out, k, v); return; }

        // ---- 逗号字符串 -> 数组 ----
        if (typeof v === 'string' && LIST_KEYS.indexOf(lower) >= 0) {
            const arr = v.split(/[,，;\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
            const p = ALIAS[lower];
            if (p) setByPath(out, p, arr);
            else if (sectionHint) setByPath(out, sectionHint + '.' + k, arr);
            else out[k] = arr;
            return;
        }

        // ---- 字段别名 ----
        const alias = ALIAS[lower];
        if (alias) { setByPath(out, alias, v); return; }

        // ---- 有区块上下文, 落到该区块 ----
        if (sectionHint) { setByPath(out, sectionHint + '.' + k, v); return; }

        out[k] = v;
    });
    return out;
}

/** 粗略判断某份配置是否属于本插件 (用于 groupId 不是 "main" 时的兜底) */
function looksLikeOurs(obj) {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj).map(function (k) { return String(k).toLowerCase(); });
    const marks = ['apikey', 'baseurl', 'model', 'identity', 'personality', 'speakingstyle',
        'groupmode', 'prefixes', 'gatewayport', 'adminuserids', 'temperature', 'maxtokens'];
    for (let i = 0; i < marks.length; i++) {
        if (keys.indexOf(marks[i]) >= 0) return true;
    }
    for (let i = 0; i < keys.length; i++) {
        if (GROUP_SECTION[keys[i]]) return true;
        if (SECTIONS.indexOf(keys[i]) >= 0) return true;
    }
    return false;
}

let _current = null;

/** 读取 archive 中的 config.json (打包在插件内的默认配置) */
function readBundledConfig() {
    try {
        if (typeof archive === 'undefined' || !archive || typeof archive.supportReadFile !== 'function') return null;
        if (!archive.supportReadFile()) return null;
        const text = archive.readString('config.json');
        return util.safeJson(text, null);
    } catch (e) {
        return null;
    }
}

/**
 * 把 Dictionary / 普通对象统一转成 [[key, value], ...]。
 * 真实环境里 config.getAllConfigs() 返回的是 .NET Dictionary 代理
 * (Object.keys 只会拿到一堆方法名), 所以这里优先走 Keys + 索引器。
 */
function dictEntries(obj) {
    const out = [];
    if (!obj || typeof obj !== 'object') return out;

    function get(k) {
        try { if (typeof obj.get_Item === 'function') return obj.get_Item(k); } catch (e) { /* next */ }
        try { if (typeof obj.Item === 'function') return obj.Item(k); } catch (e) { /* next */ }
        try { const v = obj[k]; if (v !== undefined) return v; } catch (e) { /* next */ }
        return undefined;
    }

    try {
        if (obj.Keys !== undefined && obj.Keys !== null) {
            const keys = util.toArray(obj.Keys).map(String);
            if (keys.length) {
                keys.forEach(function (k) { out.push([k, get(k)]); });
                return out;
            }
        }
    } catch (e) { /* 退化 */ }

    try {
        Object.keys(obj).forEach(function (k) { out.push([k, obj[k]]); });
    } catch (e) { /* ignore */ }
    return out;
}

/** 从 EasyBot 配置系统读取用户配置 */
function readUserConfig() {
    let primary = null;
    try {
        if (typeof config !== 'undefined' && config && typeof config.getConfigObject === 'function') {
            primary = config.getConfigObject('main');
        }
    } catch (e) {
        primary = null;
    }
    if (primary && typeof primary === 'object' && Object.keys(primary).length) return primary;

    // 兜底: 某些版本里表单分组的 groupId 未必是 "main",
    // 于是遍历全部配置, 把明显属于本插件的那份合并起来用。
    try {
        if (typeof config !== 'undefined' && config && typeof config.getAllConfigs === 'function') {
            const all = config.getAllConfigs();
            const merged = {};
            let hit = false;
            dictEntries(all).forEach(function (pair) {
                const g = pair[1];
                if (g && typeof g === 'object' && looksLikeOurs(g)) {
                    hit = true;
                    // 分组内容本身也可能是 Dictionary
                    dictEntries(g).forEach(function (kv) { merged[kv[0]] = kv[1]; });
                }
            });
            if (hit) return merged;
        }
    } catch (e) { /* ignore */ }

    return primary || null;
}

/** 载入/重载配置 */
function reload() {
    const merged = util.clone(DEFAULT_CONFIG) || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    deepMerge(merged, normalizeUserConfig(readBundledConfig()));
    deepMerge(merged, normalizeUserConfig(readUserConfig()));
    _current = merged;
    return _current;
    _invalidateToolsOverride();
}

/** 获取当前配置 (惰性载入) */
// WebUI 保存的 tools 覆盖(知识库等)会合并到 get() 的返回值上。
// 带缓存, 避免热路径每次都克隆配置 / 读库。
let _toolsOverrideCache;
let _toolsOverrideLoaded = false;

function _invalidateToolsOverride() {
    _toolsOverrideLoaded = false;
    _toolsOverrideCache = null;
}

function get() {
    if (!_current) reload();
    if (!_toolsOverrideLoaded) {
        _toolsOverrideLoaded = true;
        const t = settingsGet('tools_override', null);
        const h = settingsGet('humanize_override', null);
        _toolsOverrideCache = {
            tools: (t && typeof t === 'object') ? t : null,
            humanize: (h && typeof h === 'object') ? h : null
        };
    }
    const ov = _toolsOverrideCache;
    if (!ov || (!ov.tools && !ov.humanize)) return _current;
    const merged = util.clone(_current) || {};
    if (ov.tools) {
        merged.tools = merged.tools || {};
        Object.keys(ov.tools).forEach(function (k) { merged.tools[k] = ov.tools[k]; });
    }
    if (ov.humanize) {
        merged.humanize = merged.humanize || {};
        Object.keys(ov.humanize).forEach(function (k) { merged.humanize[k] = ov.humanize[k]; });
    }
    return merged;
}

/** 运行时覆盖某个配置路径 */
function setRuntime(path, value) {
    setByPath(get(), path, value);
    return get();
}

// ---------------- litedb settings 读写 ----------------
// 注意: 真机上 litedb.Set(集合,键,<JS对象>) 会静默写不进去, 所以统一存 JSON 字符串。

/** 读一个 settings 项(自动兼容旧的"直接存对象"格式) */
function settingsGet(key, def) {
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Get !== 'function') return def;
        const raw = litedb.Get('settings', key);
        if (raw === null || raw === undefined) return def;
        if (typeof raw === 'string') {
            const parsed = util.safeJson(raw, undefined);
            return parsed === undefined ? def : parsed;
        }
        if (typeof raw === 'object') {
            const keys = Object.keys(raw).filter(function (k) {
                return ['GetType', 'ToString', 'Equals', 'GetHashCode'].indexOf(k) < 0;
            });
            return keys.length ? raw : def;
        }
        return def;
    } catch (e) { return def; }
}

/** 写一个 settings 项(存 JSON 字符串, 保证真机能持久化) */
function settingsSet(key, value) {
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Set !== 'function') return false;
        return !!litedb.Set('settings', key, util.safeStringify(value));
    } catch (e) { return false; }
}

/** 删一个 settings 项 */
function settingsDel(key) {
    try {
        if (typeof litedb === 'undefined' || !litedb || typeof litedb.Delete !== 'function') return false;
        return !!litedb.Delete('settings', key);
    } catch (e) { return false; }
}

/** 取 behavior (合并 WebUI/命令保存的覆盖) */
function behavior() {
    const base = util.clone(get().behavior) || {};
    const override = settingsGet('behavior_override', null);
    if (override && typeof override === 'object') deepMerge(base, override);
    // ★ 列表型字段统一归一化成数组: WebUI 会直接 .join(), 万一配置里写成字符串
    //   (例如 manualCommandPrefixes: '！,!,/') 就会抛 "join is not a function",
    //   在页面上表现为**整个标签页空白** —— 这个坑踩过。
    ['prefixes', 'keywords', 'mentionNames', 'manualCommandPrefixes'].forEach(function (k) {
        if (base[k] !== undefined && !Array.isArray(base[k])) base[k] = toList(base[k]);
    });
    return base;
}

/** 保存 behavior 覆盖 (只保存传进来的字段) */
function saveBehaviorOverride(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const cur = settingsGet('behavior_override', {}) || {};
    deepMerge(cur, patch);
    return settingsSet('behavior_override', cur);
}

/** 清除 behavior 覆盖 (回到配置文件的值) */
function clearBehaviorOverride() {
    return settingsDel('behavior_override');
}

/** 取 llm 配置(合并 WebUI 保存的覆盖) */
function llmCfg() {
    const base = util.clone(get().llm) || {};
    const override = settingsGet('llm_override', null);
    if (override && typeof override === 'object') deepMerge(base, override);
    return base;
}

/** 保存 llm 覆盖(WebUI 模型页用) */
function saveLlmOverride(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const cur = settingsGet('llm_override', {}) || {};
    deepMerge(cur, patch);
    const ok = settingsSet('llm_override', cur);
    _invalidateToolsOverride();
    return ok;
}

function clearLlmOverride() {
    const ok = settingsDel('llm_override');
    _invalidateToolsOverride();
    return ok;
}

/** 保存 humanize 下的覆盖 */
function saveHumanizeOverride(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const cur = settingsGet('humanize_override', {}) || {};
    deepMerge(cur, patch);
    const ok = settingsSet('humanize_override', cur);
    _invalidateToolsOverride();
    return ok;
}

function clearHumanizeOverride() {
    const ok = settingsDel('humanize_override');
    _invalidateToolsOverride();
    return ok;
}

/** 保存 tools 下的覆盖(WebUI 知识库页用) */
function saveToolsOverride(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const cur = settingsGet('tools_override', {}) || {};
    deepMerge(cur, patch);
    const ok = settingsSet('tools_override', cur);
    _invalidateToolsOverride();
    return ok;
}

/** 清除 tools 覆盖 */
function clearToolsOverride() {
    const ok = settingsDel('tools_override');
    _invalidateToolsOverride();
    return ok;
}

/** 取 permissions (合并 WebUI 保存的覆盖) */
function permissionsCfg() {
    const base = util.clone(get().permissions) || {};
    const override = settingsGet('permissions_override', null);
    if (override && typeof override === 'object') deepMerge(base, override);
    return base;
}

/** 保存 permissions 覆盖 */
function savePermissionsOverride(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const cur = settingsGet('permissions_override', {}) || {};
    deepMerge(cur, patch);
    return settingsSet('permissions_override', cur);
}

/** 清除 permissions 覆盖 */
function clearPermissionsOverride() {
    return settingsDel('permissions_override');
}

/** 取 persona (合并运行时覆盖, 存于 litedb) */
function persona() {
    const base = util.clone(get().persona) || {};
    const override = settingsGet('persona_override', null);
    if (override && typeof override === 'object') deepMerge(base, override);
    return base;
}

/** 保存 persona 覆盖到 litedb */
function savePersonaOverride(patch) {
    const cur = settingsGet('persona_override', {}) || {};
    deepMerge(cur, patch || {});
    return settingsSet('persona_override', cur);
}

/** 该 LLM 配置是否可用 */
function llmReady() {
    const l = get().llm;
    return !!(l && l.baseUrl && l.model);
}

/**
 * 注册 EasyBot 动态配置表单 (在 enable 事件中调用)。
 */
function registerForm() {
    try {
        if (typeof form === 'undefined' || !form || typeof form.createFormData !== 'function') return false;
        const snapshot = get();
        const formData = form.createFormData('AI 对话助手', 'main', null);
        form.createForm('AI 对话助手 - 主配置', formData,
            '大模型接口、人设与行为参数。保存后插件会自动重载配置。',
            function (api, root) {
                // ---- 模型接口 ----
                const llmGroup = api.createContainerGroup('llmGroup', '大模型接口', 'OpenAI 兼容接口');
                root.addChild(llmGroup);
                llmGroup.addChild(api.createStringInput('baseUrl', '接口地址(baseUrl)', '常见: DeepSeek https://api.deepseek.com/v1 | OpenAI https://api.openai.com/v1 | 硅基流动 https://api.siliconflow.cn/v1 | 智谱 https://open.bigmodel.cn/api/paas/v4 | Agnes https://api.deepseek.com/v1', function (a, c) {
                    c.defaultValue = snapshot.llm.baseUrl;
                }));
                llmGroup.addChild(api.createStringInput('apiKey', 'API Key', '密钥, 仅保存在本地', function (a, c) {
                    c.isPassword = true;
                }));
                llmGroup.addChild(api.createStringInput('relayBase', '通用代理地址(可选)', '通常留空即可(插件用原生 .NET HTTP 自控请求头); 只有在极少数环境反射不可用时, 才需要填一个补 Content-Type 的转发地址', function (a, c) {
                    c.defaultValue = snapshot.llm.relayBase || '';
                }));
                llmGroup.addChild(api.createStringInput('model', '模型名称', '例如 deepseek-chat / gpt-4o-mini / qwen-plus', function (a, c) {
                    c.defaultValue = snapshot.llm.model;
                }));
                llmGroup.addChild(api.createNumberInput('temperature', '温度', '越高越活泼, 建议 0.6~1.1', function (a, c) {
                    c.min = 0; c.max = 2; c.step = 0.1; c.defaultValue = snapshot.llm.temperature;
                }));
                llmGroup.addChild(api.createNumberInput('maxTokens', '单次最大输出', '建议 300~1500', function (a, c) {
                    c.min = 64; c.max = 8192; c.step = 64; c.defaultValue = snapshot.llm.maxTokens;
                }));
                if (typeof api.createSelect === 'function') {
                    llmGroup.addChild(api.createSelect('authMode', '鉴权方式', 'header=放在请求头(标准); query=放在URL(部分旧版EasyBot不支持自定义请求头时用)', function (a, c) {
                        if (typeof c.addOption === 'function') {
                            c.addOption('header', 'header - Authorization 请求头(推荐)');
                            c.addOption('query', 'query - 放在 URL 查询参数里');
                            c.addOption('none', 'none - 不带鉴权');
                        }
                        c.defaultValue = snapshot.llm.authMode;
                    }));
                }
                llmGroup.addChild(api.createStringInput('authQueryParam', 'query 鉴权参数名', '默认 api_key', function (a, c) {
                    c.defaultValue = snapshot.llm.authQueryParam;
                }));
                llmGroup.addChild(api.createToggle('selfTestOnEnable', '启用时自检', '启用插件时真实调用一次模型, 用于验证配置(会消耗少量额度)', function (a, c) {
                    c.defaultValue = snapshot.llm.selfTestOnEnable; c.trueLabel = '开'; c.falseLabel = '关';
                }));

                // ---- 人设 ----
                const personaGroup = api.createContainerGroup('personaGroup', '人设', '决定它的说话方式');
                root.addChild(personaGroup);
                personaGroup.addChild(api.createStringInput('name', '机器人名字', '被叫到这个名字时会回复', function (a, c) {
                    c.defaultValue = snapshot.persona.name;
                }));
                personaGroup.addChild(api.createStringInput('identity', '身份设定', '', function (a, c) {
                    c.defaultValue = snapshot.persona.identity;
                }));
                personaGroup.addChild(api.createStringInput('personality', '性格', '', function (a, c) {
                    c.defaultValue = snapshot.persona.personality;
                }));
                personaGroup.addChild(api.createStringInput('speakingStyle', '说话风格', '', function (a, c) {
                    c.defaultValue = snapshot.persona.speakingStyle;
                }));
                personaGroup.addChild(api.createStringInput('background', '背景故事', '可留空', function (a, c) {
                    c.defaultValue = snapshot.persona.background;
                }));
                personaGroup.addChild(api.createStringInput('extraRules', '额外规则', '例如: 不要讨论政治', function (a, c) {
                    c.defaultValue = snapshot.persona.extraRules;
                }));
                personaGroup.addChild(api.createStringInput('exampleDialogue', '示例对话', '写几段"用户: ... / 你: ..."能显著影响说话风格', function (a, c) {
                    c.defaultValue = snapshot.persona.exampleDialogue;
                }));

                // ---- 视觉 ----
                const visionGroup = api.createContainerGroup('visionGroup', '图片理解(视觉)', '把消息里的图片 URL 交给模型, 需要模型支持图像输入');
                root.addChild(visionGroup);
                visionGroup.addChild(api.createToggle('enabled', '允许模型看图片', '需要模型支持图像输入(如 deepseek-chat / gpt-4o); 图片由模型服务端去抓取', function (a, c) {
                    c.defaultValue = snapshot.vision.enabled; c.trueLabel = '开'; c.falseLabel = '关';
                }));
                visionGroup.addChild(api.createNumberInput('lookbackSeconds', '回看秒数(先发图再@它)', '本条消息没带图时, 往前找这段时间内的图片; 0=关闭', function (a, c) {
                    c.min = 0; c.max = 1800; c.step = 10; c.defaultValue = snapshot.vision.lookbackSeconds;
                }));
                visionGroup.addChild(api.createNumberInput('maxImages', '每条消息最多几张图', '', function (a, c) {
                    c.min = 1; c.max = 10; c.step = 1; c.defaultValue = snapshot.vision.maxImages;
                }));
                visionGroup.addChild(api.createToggle('describeOnReceive', '收到图片就生成描述并存入记忆', '学 MaiBot: 用模型描述一次, 文字进上下文, 后续引用不依赖当场看图(每张图多消耗一次调用)', function (a, c) {
                    c.defaultValue = snapshot.vision.describeOnReceive; c.trueLabel = '开'; c.falseLabel = '关';
                }));
                visionGroup.addChild(api.createToggle('includeSticker', '包含QQ表情包图片', '', function (a, c) {
                    c.defaultValue = snapshot.vision.includeSticker; c.trueLabel = '包含'; c.falseLabel = '忽略';
                }));

                // ---- 触发 ----
                const triggerGroup = api.createContainerGroup('triggerGroup', '触发策略', '');
                root.addChild(triggerGroup);
                if (typeof api.createSelect === 'function') {
                    triggerGroup.addChild(api.createSelect('groupMode', '群聊触发方式', 'mention=需要@或叫名字; always=每条都回; random=偶尔插话', function (a, c) {
                        if (typeof c.addOption === 'function') {
                            c.addOption('mention', 'mention - 被@/叫名字/关键词才回');
                            c.addOption('always', 'always - 每条都回(有冷却)');
                            c.addOption('random', 'random - 被叫到或随机插话');
                        }
                        c.defaultValue = snapshot.behavior.groupMode;
                    }));
                }
                triggerGroup.addChild(api.createNumberInput('randomChance', '随机插话概率', '0~1, 仅 random 模式生效', function (a, c) {
                    c.min = 0; c.max = 1; c.step = 0.01; c.defaultValue = snapshot.behavior.randomChance;
                }));
                triggerGroup.addChild(api.createStringInput('prefixes', '触发前缀(逗号分隔)', '例如 ai,小助手', function (a, c) {
                    c.defaultValue = snapshot.behavior.prefixes.join(',');
                }));
                triggerGroup.addChild(api.createStringInput('keywords', '触发关键词(逗号分隔)', '可留空', function (a, c) {
                    c.defaultValue = snapshot.behavior.keywords.join(',');
                }));
                triggerGroup.addChild(api.createNumberInput('cooldownSec', '回复冷却(秒)', '', function (a, c) {
                    c.min = 0; c.max = 600; c.step = 1; c.defaultValue = snapshot.behavior.cooldownSec;
                }));
                triggerGroup.addChild(api.createNumberInput('maxRepliesPerMinute', '每分钟最多回复条数', '', function (a, c) {
                    c.min = 1; c.max = 120; c.step = 1; c.defaultValue = snapshot.behavior.maxRepliesPerMinute;
                }));

                // ---- 拟人化 ----
                const humanGroup = api.createContainerGroup('humanGroup', '拟人化', '');
                root.addChild(humanGroup);
                humanGroup.addChild(api.createToggle('humanizeEnabled', '启用拟人化', '打字延迟 / 分段发送 / 随机引用', function (a, c) {
                    c.defaultValue = snapshot.humanize.enabled; c.trueLabel = '开'; c.falseLabel = '关';
                }));
                humanGroup.addChild(api.createNumberInput('typingPerCharMs', '每字打字耗时(ms)', '', function (a, c) {
                    c.min = 0; c.max = 1000; c.step = 5; c.defaultValue = snapshot.humanize.typingPerCharMs;
                }));
                humanGroup.addChild(api.createNumberInput('segmentMaxChars', '单条消息最大字数', '超过会拆成多条发送', function (a, c) {
                    c.min = 20; c.max = 2000; c.step = 10; c.defaultValue = snapshot.humanize.segmentMaxChars;
                }));
                humanGroup.addChild(api.createNumberInput('segmentMaxCount', '最多拆成几条', '', function (a, c) {
                    c.min = 1; c.max = 10; c.step = 1; c.defaultValue = snapshot.humanize.segmentMaxCount;
                }));

                // ---- 工具 ----
                const toolGroup = api.createContainerGroup('toolGroup', '工具调用', '允许大模型调用其它插件/服务端扩展');
                root.addChild(toolGroup);
                toolGroup.addChild(api.createToggle('toolsEnabled', '启用工具调用', '', function (a, c) {
                    c.defaultValue = snapshot.tools.enabled; c.trueLabel = '开'; c.falseLabel = '关';
                }));
                toolGroup.addChild(api.createToggle('allowRunCommand', '允许执行服务器命令', '危险: 请配合命令黑名单使用', function (a, c) {
                    c.defaultValue = snapshot.tools.allowRunCommand; c.trueLabel = '允许'; c.falseLabel = '禁止';
                }));
                toolGroup.addChild(api.createToggle('allowSendMessage', '允许 AI 主动发消息', '让 AI 能主动往群里/私聊发消息(默认关闭)', function (a, c) {
                    c.defaultValue = snapshot.tools.allowSendMessage; c.trueLabel = '允许'; c.falseLabel = '禁止';
                }));
                toolGroup.addChild(api.createStringInput('defaultServerToken', '默认服务器令牌', '多台服务器在线时默认查询哪一台(可留空)', function (a, c) {
                    c.defaultValue = snapshot.tools.defaultServerToken;
                }));
                toolGroup.addChild(api.createStringInput('proactiveAllowedGroups', '允许主动发消息的群(逗号分隔)', '留空=不限制', function (a, c) {
                    c.defaultValue = snapshot.tools.proactiveAllowedGroups.join(',');
                }));
                toolGroup.addChild(api.createStringInput('commandBlacklist', '命令黑名单(逗号分隔)', '禁止 AI 执行的命令', function (a, c) {
                    c.defaultValue = snapshot.tools.commandBlacklist.join(',');
                }));
                toolGroup.addChild(api.createToggle('gatewayEnabled', '开启工具网关(供其它插件注册工具)', '', function (a, c) {
                    c.defaultValue = snapshot.tools.gateway.enabled; c.trueLabel = '开'; c.falseLabel = '关';
                }));
                toolGroup.addChild(api.createNumberInput('gatewayPort', '工具网关端口', '', function (a, c) {
                    c.min = 1024; c.max = 65535; c.step = 1; c.defaultValue = snapshot.tools.gateway.port;
                }));
                toolGroup.addChild(api.createStringInput('gatewayToken', '工具网关令牌', '可留空; 填写后其它插件注册工具需带此令牌', function (a, c) {
                    c.isPassword = true;
                }));

                // ---- 指令权限 ----
                const permGroup = api.createContainerGroup('permGroup', '指令权限(分人分级)', '允许 AI 在 MC 服务器执行指令, 并按人限权');
                root.addChild(permGroup);
                permGroup.addChild(api.createStringInput('commandHints', '本服可用指令清单', '写清楚本服能用的指令, 会喂给AI帮它选对指令; 例如: list 看在线, gm 1 切创造, home 回家', function (a, c) {
                    c.defaultValue = snapshot.tools.commandHints || '';
                }));
                permGroup.addChild(api.createStringInput('commandBook', '指令知识库(常用指令)', '每行: 指令|说明|关键词|等级。例: easywhitelist add {player}|把玩家加入白名单|白名单,加白|3', function (a, c) {
                    c.defaultValue = snapshot.tools.commandBook || '';
                }));
                permGroup.addChild(api.createToggle('wikiEnabled', '允许 AI 查 Minecraft Wiki 兜底', '知识库里找不到指令时, 让它去查 Wiki 的原版写法(需要容器能联网)', function (a, c) {
                    c.defaultValue = !!(snapshot.tools.wiki && snapshot.tools.wiki.enabled); c.trueLabel = '允许'; c.falseLabel = '禁止';
                }));
                permGroup.addChild(api.createStringInput('wikiEndpoints', 'Wiki API 地址', '每行: 名称|API地址。默认中文 Minecraft Wiki', function (a, c) {
                    c.defaultValue = (snapshot.tools.wiki && snapshot.tools.wiki.endpoints) || '';
                }));
                permGroup.addChild(api.createStringInput('commandRules', '专用指令规则(意图->指令)', '每行一条: 工具名|中文标题|指令模板|参数|等级。例: add_whitelist|把玩家加入白名单|easywhitelist add {player}|player:玩家名|3', function (a, c) {
                    c.defaultValue = snapshot.tools.commandRules || '';
                }));
                permGroup.addChild(api.createStringInput('commandRewrites', '指令改写规则', '每行一条: 正则=替换。例: ^whitelist\\b=easywhitelist', function (a, c) {
                    c.defaultValue = snapshot.tools.commandRewrites || '';
                }));
                permGroup.addChild(api.createToggle('permissionsEnabled', '启用指令权限系统', '关掉=不做限制(不建议)', function (a, c) {
                    c.defaultValue = snapshot.permissions.enabled; c.trueLabel = '启用'; c.falseLabel = '关闭';
                }));
                permGroup.addChild(api.createStringInput('groupScopes', '按群分类的等级(每行一个群)', '格式: 群号|QQ:等级,QQ:等级。同一个人在不同群可以有不同等级', function (a, c) {
                    c.defaultValue = snapshot.permissions.groupScopes;
                }));
                permGroup.addChild(api.createStringInput('userLevels', '全局高权限用户(QQ:等级, 不限群)', '等级 0=禁指令 1=安全 2=普通 3=高危', function (a, c) {
                    c.defaultValue = snapshot.permissions.userLevels;
                }));
                permGroup.addChild(api.createNumberInput('groupOwnerLevel', '群主自动等级', '', function (a, c) {
                    c.min = 0; c.max = 3; c.step = 1; c.defaultValue = snapshot.permissions.groupOwnerLevel;
                }));
                permGroup.addChild(api.createNumberInput('groupAdminLevel', '群管理自动等级', '', function (a, c) {
                    c.min = 0; c.max = 3; c.step = 1; c.defaultValue = snapshot.permissions.groupAdminLevel;
                }));
                permGroup.addChild(api.createNumberInput('defaultLevel', '其他人的等级', '默认 0 = 不能执行任何指令', function (a, c) {
                    c.min = 0; c.max = 3; c.step = 1; c.defaultValue = snapshot.permissions.defaultLevel;
                }));
                permGroup.addChild(api.createStringInput('safeCommands', '安全指令(逗号分隔)', '等级 1 及以上可执行', function (a, c) {
                    c.defaultValue = (snapshot.permissions.safeCommands || []).join(',');
                }));
                permGroup.addChild(api.createNumberInput('unknownCommandLevel', '未列出的指令需要等级', '默认 3 = 按高危处理', function (a, c) {
                    c.min = 0; c.max = 3; c.step = 1; c.defaultValue = snapshot.permissions.unknownCommandLevel;
                }));

                // ---- 权限 ----
                const accessGroup = api.createContainerGroup('accessGroup', '权限与范围', '');
                root.addChild(accessGroup);
                accessGroup.addChild(api.createStringInput('adminUserIds', '管理员QQ(逗号分隔)', '可使用 /ai 管理命令', function (a, c) {
                    c.defaultValue = snapshot.access.adminUserIds.join(',');
                }));
                accessGroup.addChild(api.createStringInput('allowGroupIds', '允许的群号(逗号分隔)', '留空=全部群', function (a, c) {
                    c.defaultValue = snapshot.access.allowGroupIds.join(',');
                }));
                accessGroup.addChild(api.createStringInput('denyGroupIds', '屏蔽的群号(逗号分隔)', '', function (a, c) {
                    c.defaultValue = snapshot.access.denyGroupIds.join(',');
                }));
            });
        return true;
    } catch (e) {
        try { logger.warning('[ai-chat] 注册配置表单失败: {0}', e && e.message ? e.message : e); } catch (x) { }
        return false;
    }
}

/** 把逗号分隔字符串转数组 (兼容数组输入) */
function toList(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (v === null || v === undefined || v === '') return [];
    return String(v).split(/[,，;\n]/).map(function (x) { return String(x).trim(); }).filter(Boolean);
}

/** 把字符串转 ID 列表 (统一成字符串) */
function toIdList(v) {
    return toList(v).map(function (x) { return String(x); });
}

module.exports = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    get: get,
    reload: reload,
    setRuntime: setRuntime,
    persona: persona,
    savePersonaOverride: savePersonaOverride,
    behavior: behavior,
    permissions: permissionsCfg,
    llm: llmCfg,
    saveLlmOverride: saveLlmOverride,
    clearLlmOverride: clearLlmOverride,
    saveToolsOverride: saveToolsOverride,
    saveHumanizeOverride: saveHumanizeOverride,
    clearHumanizeOverride: clearHumanizeOverride,
    clearToolsOverride: clearToolsOverride,
    savePermissionsOverride: savePermissionsOverride,
    clearPermissionsOverride: clearPermissionsOverride,
    saveBehaviorOverride: saveBehaviorOverride,
    clearBehaviorOverride: clearBehaviorOverride,
    llmReady: llmReady,
    registerForm: registerForm,
    getByPath: getByPath,
    setByPath: setByPath,
    deepMerge: deepMerge,
    toList: toList,
    toIdList: toIdList
};
