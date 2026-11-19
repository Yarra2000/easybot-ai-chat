'use strict';

/**
 * WebUI 管理页面 (EasyBot 菜单系统)。
 *
 * 提供一个可视化面板: 查看运行状态、工具列表、会话上下文、长期记忆,
 * 并能清空数据 / 重载配置 / 重启工具网关 / 直接测试对话。
 */

const util = require('./util.js');
const config = require('./config.js');
const memory = require('./memory.js');
const registry = require('./tools/registry.js');
const gateway = require('./tools/gateway.js');
const chat = require('./chat.js');
const permissions = require('./permissions.js');
const llm = require('./llm.js');
const cmdbook = require('./cmdbook.js');
const builtin = require('./tools/builtin.js');

/**
 * 回复逻辑预设。点一下即生效并保存(存进 litedb 的 behavior_override)。
 */
const PRESETS = [
    {
        key: 'quiet', name: '安静助手', desc: '只在 @它 或叫名字时回，其它时候只听不说（推荐）',
        values: {
            enabled: true, groupMode: 'mention', prefixes: ['ai'], keywords: [], mentionNames: [],
            randomChance: 0, continuationWindowSec: 60, continuationAnyone: false,
            cooldownSec: 5, maxRepliesPerMinute: 6
        }
    },
    {
        key: 'friend', name: '群友感', desc: '被叫到就回；刚聊过会接着聊；偶尔主动插话',
        values: {
            enabled: true, groupMode: 'random', randomChance: 0.03,
            continuationWindowSec: 180, continuationAnyone: false,
            cooldownSec: 4, maxRepliesPerMinute: 8
        }
    },
    {
        key: 'chatty', name: '话痨', desc: '几乎每条群消息都回，靠冷却和每分钟上限压制',
        values: {
            enabled: true, groupMode: 'always', cooldownSec: 8,
            maxRepliesPerMinute: 5, continuationWindowSec: 120
        }
    },
    {
        key: 'prefix', name: '只认前缀', desc: '只有以指定前缀开头才回，最不打扰',
        values: {
            enabled: true, groupMode: 'mention', prefixes: ['ai', '小助手'],
            keywords: [], mentionNames: [], continuationWindowSec: 0, continuationAnyone: false
        }
    },
    {
        key: 'casual', name: '随缘插话', desc: '很少主动说话；被叫到才回，且不接续话题',
        values: {
            enabled: true, groupMode: 'random', randomChance: 0.01,
            continuationWindowSec: 0, continuationAnyone: false
        }
    },
    {
        key: 'atOnly', name: '只认 @', desc: '只有 @它 才回，其它一概不理（连叫名字也不理）',
        values: {
            enabled: true, groupMode: 'mention',
            nameTrigger: false, replyTrigger: false,
            prefixes: [], keywords: [], mentionNames: [],
            continuationWindowSec: 0, continuationAnyone: false
        }
    },
    {
        key: 'off', name: '暂停回复', desc: '任何群消息都不回（仍然记录上下文，随时可再打开）',
        values: { enabled: false }
    }
];

/** 会话列表 */
function listSessions() {
    const out = [];
    try {
        memory._store.keys('context').forEach(function (key) {
            const ctx = memory.getContext(key);
            out.push({
                key: key,
                messages: (ctx.messages || []).length,
                updated: ctx.updated || 0,
                updatedText: ctx.updated ? util.formatTime(ctx.updated) : '-',
                enabled: memory.isSessionEnabled(key)
            });
        });
    } catch (e) { /* ignore */ }
    out.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    return out;
}

/** 前端 action 分发 */
async function onAction(action) {
    const method = String((action && action.method) || '');
    const p = (action && action.parameters) || {};
    try {
        switch (method) {
            case 'status':
                return {
                    ok: true,
                    status: chat.status(),
                    llm: { model: config.llm().model, baseUrl: config.llm().baseUrl }
                };
            case 'tools':
                return {
                    ok: true,
                    tools: registry.list().map(function (t) {
                        return {
                            name: t.name, description: t.description, source: t.source,
                            plugin: t.plugin, parameters: t.parameters
                        };
                    })
                };
            case 'memory':
                return {
                    ok: true,
                    stats: memory.stats(),
                    facts: memory.allFacts().slice(0, 200).map(function (f) {
                        return { id: f.id, text: f.text, scope: f.scope, owner: f.owner, time: util.formatTime(f.ts) };
                    }),
                    sessions: listSessions()
                };
            case 'session': {
                const key = String(p.key || '');
                const ctx = memory.getContext(key);
                return { ok: true, key: key, messages: (ctx.messages || []).slice(-40) };
            }
            case 'clearContext': {
                if (p.key) memory.clearContext(String(p.key));
                else memory.clearAllContexts();
                return { ok: true, stats: memory.stats() };
            }
            case 'clearMemory': {
                const n = memory.clearFacts({});
                return { ok: true, removed: n, stats: memory.stats() };
            }
            case 'forgetFact': {
                return { ok: memory.forgetFact(String(p.id || '')), stats: memory.stats() };
            }
            case 'saveMemory': {
                const f = memory.addFact(String(p.text || ''), { scope: p.scope || 'global' });
                return { ok: !!f, fact: f, stats: memory.stats() };
            }
            case 'toggleSession': {
                const key = String(p.key || '');
                memory.setSessionEnabled(key, !memory.isSessionEnabled(key));
                return { ok: true, enabled: memory.isSessionEnabled(key) };
            }
            case 'reloadConfig': {
                config.reload();
                return { ok: true, status: chat.status() };
            }
            case 'restartGateway': {
                const ok = await gateway.restart();
                return { ok: ok, gateway: gateway.status() };
            }
            case 'toolsCfg': {
                const t = (config.get().tools || {});
                return { ok: true, logSources: (t.logSources || []), modInstallTargets: (t.modInstallTargets || []) };
            }
            case 'toolsCfgSave': {
                const parseLines = function (raw, keys) {
                    const out = [];
                    String(raw || '').split(/\r?\n/).forEach(function (line) {
                        const t = String(line || '').trim();
                        if (!t || t.charAt(0) === '#') return;
                        const parts = t.split('|').map(function (x) { return x.trim(); });
                        const o = {};
                        keys.forEach(function (k, i) { if (parts[i]) o[k] = parts[i]; });
                        if (Object.keys(o).length) out.push(o);
                    });
                    return out;
                };
                const ls = parseLines(p && p.logSources, ['key', 'name', 'path']);
                const mt = parseLines(p && p.modInstallTargets, ['server', 'modsDir', 'container']);
                const normLs = ls.filter(function (x) { return x.key && x.path; }).map(function (x) {
                    return { key: x.key, name: x.name || x.key,
                             paths: String(x.path).split(',').map(function (q) { return q.trim(); }).filter(Boolean) };
                });
                const normMt = mt.filter(function (x) { return x.server && x.modsDir; });
                const ok = config.saveToolsOverride({ logSources: normLs, modInstallTargets: normMt });
                logger.info('[ai-chat] WebUI 保存工具配置: 日志来源 {0} 条, 装mod目标 {1} 条', normLs.length, normMt.length);
                return { ok: ok, count: { logSources: normLs.length, modInstallTargets: normMt.length } };
            }
            case 'scanTools': {
                const discover = require('./tools/discover.js');
                const r1 = discover.scan();
                const r2 = discover.loadConfiguredTools();
                return { ok: true, discover: r1, configured: r2, tools: registry.list().length };
            }
            case 'test': {
                const prompt = util.trim(p.prompt);
                if (!prompt) return { ok: false, error: '请输入内容' };
                const r = await chat.askOnce(prompt, { senderName: '网页测试' });
                return { ok: true, content: r.content, toolCalls: (r.toolCalls || []).map(function (t) { return t.name; }) };
            }
            case 'behaviorGet':
                return {
                    ok: true,
                    humanize: config.get().humanize,
                    behavior: config.behavior(),
                    base: config.get().behavior,
                    presets: PRESETS,
                    access: {
                        allowGroupIds: config.get().access.allowGroupIds,
                        denyGroupIds: config.get().access.denyGroupIds
                    }
                };
            case 'behaviorSave': {
                const patch = {};
                const b = p.behavior || {};
                ['enabled', 'groupMode', 'continuationAnyone', 'nameTrigger', 'replyTrigger'].forEach(function (k) {
                    if (b[k] !== undefined) patch[k] = !!b[k];
                });
                ['continuationWindowSec', 'cooldownSec', 'maxRepliesPerMinute', 'randomChance'].forEach(function (k) {
                    if (b[k] !== undefined) patch[k] = Number(b[k]);
                });
                ['manualCommandPrefixes'].forEach(function (k) {
                    if (b[k] !== undefined) {
                        patch[k] = Array.isArray(b[k]) ? b[k]
                            : String(b[k]).split(/[,，;\\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
                    }
                });
                if (b.manualCommandAction !== undefined) patch.manualCommandAction = String(b.manualCommandAction);
                ['prefixes', 'keywords', 'mentionNames'].forEach(function (k) {
                    if (b[k] !== undefined) {
                        patch[k] = Array.isArray(b[k]) ? b[k]
                            : String(b[k]).split(/[,，;\\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
                    }
                });
                config.saveBehaviorOverride(patch);
                if (p.humanize && typeof p.humanize === 'object') {
                    const hp = {};
                    if (p.humanize.stripRegex !== undefined) hp.stripRegex = String(p.humanize.stripRegex);
                    // 布尔/数字型拟人化参数(页面发什么就存什么, 只收白名单内的键)
                    ['splitOnNewline', 'multiSegment', 'enabled'].forEach(function (k) {
                        if (p.humanize[k] !== undefined) hp[k] = !!p.humanize[k];
                    });
                    ['segmentMaxChars', 'segmentMaxCount', 'quoteChance', 'atChance', 'emojiChance',
                        'typingBaseMs', 'typingPerCharMs', 'segmentDelayBaseMs', 'segmentDelayPerCharMs'
                    ].forEach(function (k) {
                        if (p.humanize[k] !== undefined) hp[k] = Number(p.humanize[k]);
                    });
                    config.saveHumanizeOverride(hp);
                }
                return { ok: true, behavior: config.behavior(), humanize: config.get().humanize };
            }
            case 'behaviorReset':
                config.clearBehaviorOverride();
                return { ok: true, behavior: config.behavior() };
            case 'behaviorPreset': {
                const hit = PRESETS.filter(function (x) { return x.key === String(p.key || ''); })[0];
                if (!hit) return { ok: false, error: '未知预设: ' + p.key };
                // 预设是"整套"的: 先清空再写入, 否则会残留旧的关键词等
                config.clearBehaviorOverride();
                config.saveBehaviorOverride(hit.values);
                return { ok: true, preset: hit.key, behavior: config.behavior() };
            }
            case 'behaviorTest': {
                const text = util.trim(p.text) || '你好';
                const groupId = util.trim(p.groupId) || (config.get().access.allowGroupIds || [])[0] || 'sim';
                const key = memory.sessionKey('group', groupId);
                const selfId = '10000';
                const senderId = String(p.senderId || '10001');
                if (p.replyBot) chat.markOwnMessage(key, '__sim_own__');
                if (p.continuation) memory.setState(key, { lastReplyAt: util.now(), lastSenderId: senderId });
                else memory.setState(key, { lastReplyAt: 0, lastSenderId: '' });
                const raw = (p.at ? '[CQ:at,qq=' + selfId + ']' : '') +
                    (p.replyBot ? '[CQ:reply,id=__sim_own__]' : '') + text;
                const ev = {
                    SelfId: selfId, SenderId: senderId, PeerId: groupId, MessageId: 'sim-msg',
                    SenderName: '测试用户', SenderRole: 'member', RawMessage: raw, Messages: []
                };
                const decision = chat.decideReply(ev, 'group', key, chat.extractText(ev));
                return {
                    ok: true, decision: decision, parsedText: chat.extractText(ev),
                    effective: config.behavior(),
                    sessionAllowed: (config.get().access.allowGroupIds || []).length === 0 ||
                        (config.get().access.allowGroupIds || []).indexOf(String(groupId)) >= 0
                };
            }
            case 'llmGet': {
                const l = config.llm() || {};
                const key = String(l.apiKey || '');
                return {
                    ok: true,
                    llm: {
                        baseUrl: l.baseUrl || '', model: l.model || '', authMode: l.authMode || 'header',
                        relayBase: l.relayBase || '', maxToolRounds: l.maxToolRounds,
                        authQueryParam: l.authQueryParam || '',
                        apiKeyMasked: key ? (key.slice(0, 6) + '****' + key.slice(-4)) : '',
                        apiKeySet: !!key
                    },
                    effectiveUrl: llm.endpoint(l.baseUrl) ? llm.viaRelay(llm.endpoint(l.baseUrl), l.relayBase) : '',
                    authOk: (l.authMode || 'header') === 'none' || !!key
                };
            }
            case 'llmSave': {
                const patch = {};
                ['baseUrl', 'model', 'relayBase', 'authMode', 'authQueryParam'].forEach(function (k) {
                    if (p[k] !== undefined) patch[k] = String(p[k]).trim();
                });
                if (p.maxToolRounds !== undefined && p.maxToolRounds !== '') patch.maxToolRounds = Number(p.maxToolRounds);
                if (p.apiKey !== undefined && String(p.apiKey) !== '') patch.apiKey = String(p.apiKey).trim();
                config.saveLlmOverride(patch);
                return { ok: true };
            }
            case 'llmReset':
                config.clearLlmOverride();
                return { ok: true };
            case 'llmClearKey':
                config.saveLlmOverride({ apiKey: '' });
                return { ok: true };
            case 'llmTest': {
                const t0 = util.now();
                try {
                    const r = await llm.chatOnce({
                        messages: [{ role: 'user', content: util.trim(p.prompt) || '你好，请用一句话打个招呼' }],
                        maxTokens: 80,
                        __skipCooldown: true
                    });
                    return { ok: true, ms: util.now() - t0, reply: util.truncate(String(r.content || ''), 200) };
                } catch (e) {
                    return { ok: false, ms: util.now() - t0, error: String((e && e.message) || e) };
                }
            }
            case 'kbGet': {
                const raw = ((config.get().tools && config.get().tools.commandBook) || '');
                const checked = cmdbook.parseChecked();
                return {
                    ok: true,
                    raw: raw,
                    entries: checked.entries,
                    errors: checked.errors,
                    inDescription: Number(config.get().tools.commandBookInDescription) || 8
                };
            }
            case 'kbSave': {
                const patch = {};
                if (p.commandBook !== undefined) patch.commandBook = String(p.commandBook);
                if (p.commandBookInDescription !== undefined && p.commandBookInDescription !== '') {
                    patch.commandBookInDescription = Number(p.commandBookInDescription);
                }
                config.saveToolsOverride(patch);
                try { builtin.refreshCommandTool(); } catch (e) { /* ignore */ }
                const checked2 = cmdbook.parseChecked();
                return { ok: true, entries: checked2.entries, errors: checked2.errors };
            }
            case 'kbReset':
                config.clearToolsOverride();
                try { builtin.refreshCommandTool(); } catch (e) { /* ignore */ }
                return { ok: true, entries: cmdbook.parseChecked().entries, errors: [] };
            case 'kbTest': {
                const q = util.trim(p.query);
                const hits = cmdbook.search(q);
                return { ok: true, query: q, hits: hits, text: cmdbook.searchText(q) };
            }
            case 'permGet': {
                const pcfg = config.permissions() || {};
                const groups = (config.get().access.allowGroupIds || []).map(String);
                // 群名 + QQ 昵称(拿不到就留空)
                const gnames = {};
                try {
                    if (typeof framework !== 'undefined' && framework && typeof framework.GetGroupsAsync === 'function') {
                        const gs = util.toArray(await framework.GetGroupsAsync());
                        gs.forEach(function (g) {
                            const id = String((g && (g.GroupId || g.Id || g.groupId)) || '');
                            const nm = String((g && (g.Name || g.GroupName || g.name)) || '');
                            if (id && nm) gnames[id] = nm;
                        });
                    }
                } catch (e) { /* ignore */ }
                const qnames = {};
                try {
                    if (typeof db !== 'undefined' && db && typeof db.GetSocialAccount === 'function') {
                        const ov = permissions.overview(groups, {});
                        const all = ov.globalUsers.map(function (x) { return x.qq; });
                        ov.groups.forEach(function (g) { g.members.forEach(function (m) { if (all.indexOf(m.qq) < 0) all.push(m.qq); }); });
                        all.slice(0, 60).forEach(function (qq) {
                            try {
                                const acc = db.GetSocialAccount('qq', String(qq));
                                if (acc && acc.Name) qnames[qq] = String(acc.Name);
                            } catch (e) { /* ignore */ }
                        });
                    }
                } catch (e) { /* ignore */ }
                Object.keys(qnames).forEach(function (qq) { gnames[qq] = qnames[qq]; });
                return {
                    ok: true,
                    overview: permissions.overview(groups, gnames),
                    raw: {
                        groupScopes: pcfg.groupScopes || '',
                        userLevels: pcfg.userLevels || '',
                        defaultLevel: pcfg.defaultLevel,
                        groupOwnerLevel: pcfg.groupOwnerLevel,
                        groupAdminLevel: pcfg.groupAdminLevel,
                        unknownCommandLevel: pcfg.unknownCommandLevel,
                        enabled: pcfg.enabled !== false
                    },
                    levelNames: permissions.LEVEL_NAMES
                };
            }
            case 'permSave': {
                const patch = {};
                ['defaultLevel', 'groupOwnerLevel', 'groupAdminLevel', 'unknownCommandLevel'].forEach(function (k) {
                    if (p[k] !== undefined && p[k] !== '') patch[k] = Number(p[k]);
                });
                if (p.enabled !== undefined) patch.enabled = !!p.enabled;
                if (p.groupScopes !== undefined) patch.groupScopes = String(p.groupScopes);
                if (p.userLevels !== undefined) patch.userLevels = String(p.userLevels);
                config.savePermissionsOverride(patch);
                return { ok: true, overview: permissions.overview((config.get().access.allowGroupIds || []).map(String), {}) };
            }
            case 'permReset':
                config.clearPermissionsOverride();
                return { ok: true };
            case 'getPersona':
                return { ok: true, persona: config.persona() };
            case 'savePersona': {
                const patch = {};
                ['name', 'identity', 'personality', 'speakingStyle', 'background', 'extraRules', 'exampleDialogue'].forEach(function (k) {
                    if (p[k] !== undefined) patch[k] = String(p[k]);
                });
                config.savePersonaOverride(patch);
                return { ok: true, persona: config.persona() };
            }
            default:
                return { ok: false, error: '未知方法: ' + method };
        }
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}

/**
 * 页面 HTML。
 * 注意: 这里刻意只使用「单引号数组 + 双引号 JS 字符串」的写法,
 * 并在浏览器端用 data-* 属性 + 事件委托, 避免嵌套引号转义出错。
 */
function pageHtml() {
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>AI 对话助手</title>',
        '<style>',
        'body{margin:0;padding:20px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#222}',
        'h1{font-size:20px;margin:0 0 4px}.sub{color:#888;font-size:13px;margin-bottom:16px}',
        '.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}',
        '.tabs button{border:1px solid #ddd;background:#fff;padding:6px 14px;border-radius:16px;cursor:pointer;font-size:13px}',
        '.tabs button.active{background:#1677ff;color:#fff;border-color:#1677ff}',
        '.card{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}',
        '.card h2{font-size:15px;margin:0 0 10px}',
        '.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:8px}',
        'button.act{background:#1677ff;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px}',
        'button.act.gray{background:#eef0f3;color:#333}',
        'button.act.red{background:#ff4d4f}',
        'table{width:100%;border-collapse:collapse;font-size:13px}',
        'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top}',
        'th{color:#888;font-weight:500}',
        'code{background:#f2f3f5;padding:1px 5px;border-radius:4px;font-size:12px}',
        'input,textarea,select{width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px;font-family:inherit}',
        'textarea{min-height:70px;resize:vertical}',
        '.muted{color:#999;font-size:12px}',
        '.ok{color:#52c41a}.err{color:#ff4d4f}',
        'pre{background:#f7f8fa;padding:10px;border-radius:6px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}',
        '.hide{display:none}',
        '.msg{padding:6px 10px;border-radius:8px;margin-bottom:6px;font-size:13px;white-space:pre-wrap;word-break:break-word}',
        '.msg.user{background:#eef3ff}.msg.assistant{background:#f2f8f2}',
        '</style>',
        '</head>',
        '<body>',
        '<h1>🤖 AI 对话助手</h1>',
        '<div class="sub">仿 MaiBot 的拟人化大模型对话 · 支持调用其它插件作为工具</div>',
        '<div class="tabs">',
        '<button data-tab="dash" class="active">总览</button>',
        '<button data-tab="tools">工具</button>',
        '<button data-tab="mem">记忆与会话</button>',
        '<button data-tab="persona">人设</button>',
        '<button data-tab="reply">回复逻辑</button>',
        '<button data-tab="perm">权限</button>',
        '<button data-tab="kb">指令知识库</button>',
        '<button data-tab="llm">模型</button>',
        '<button data-tab="test">对话测试</button>',
        '</div>',
        '<div id="tab-dash" class="tabpane"></div>',
        '<div id="tab-tools" class="tabpane hide"></div>',
        '<div id="tab-mem" class="tabpane hide"></div>',
        '<div id="tab-persona" class="tabpane hide"></div>',
        '<div id="tab-reply" class="tabpane hide"></div>',
        '<div id="tab-perm" class="tabpane hide"></div>',
        '<div id="tab-kb" class="tabpane hide"></div>',
        '<div id="tab-llm" class="tabpane hide"></div>',
        '<div id="tab-test" class="tabpane hide"></div>',
        '<script>',
        'var $=function(id){return document.getElementById(id)};',
        'var esc=function(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")};',
        'function call(method,params){try{if(!window.webuikit||typeof window.webuikit.action!=="function"){return Promise.reject(new Error("页面桥接还没就绪(webuikit 不可用), 请稍等或刷新页面"))}return Promise.resolve(window.webuikit.action(method,params||{}))}catch(e){return Promise.reject(e)}}',
        // ★ 页面刚加载时 window.webuikit 可能还没注入 -> 等它就绪再跑初始化, 否则会弹 "reading action of undefined"
        'function whenBridgeReady(cb){',
        '  if(window.webuikit&&typeof window.webuikit.action==="function"){cb();return}',
        '  var n=0;var t=setInterval(function(){',
        '    if(window.webuikit&&typeof window.webuikit.action==="function"){clearInterval(t);cb()}',
        '    else if(++n>40){clearInterval(t);try{showTabErr("dash",new Error("页面桥接未就绪(window.webuikit 不可用), 请刷新页面"))}catch(e){}}',
        '  },250);',
        '}',
        'document.querySelectorAll(".tabs button").forEach(function(b){b.onclick=function(){',
        '  document.querySelectorAll(".tabs button").forEach(function(x){x.classList.remove("active")});',
        '  document.querySelectorAll(".tabpane").forEach(function(x){x.classList.add("hide")});',
        '  b.classList.add("active"); $("tab-"+b.dataset.tab).classList.remove("hide");',
        '  var T=b.dataset.tab;',
        '  if(T==="tools")load("tools",loadTools); if(T==="mem")load("mem",loadMem);',
        '  if(T==="dash")load("dash",loadDash); if(T==="persona")load("persona",loadPersona);',
        '  if(T==="reply")load("reply",loadReply);',
        '  if(T==="perm")load("perm",loadPerm);',
        '  if(T==="kb")load("kb",loadKb);',
        '  if(T==="llm")load("llm",loadLlm);',
        '  if(T==="test")load("test",loadTest);',
        '}});',
        // ---- 总览 ----
        'function asList(v){if(Array.isArray(v))return v;if(v===null||v===undefined)return [];return String(v).split(/[,，;\\n]/).map(function(x){return x.trim()}).filter(Boolean)}',
        'function showTabErr(tab,e){var el=document.getElementById("tab-"+tab);',
        '  if(el)el.innerHTML="<div class=card><h2>加载出错</h2><div class=err>"+esc(String(e&&e.message||e))+"</div></div>";',
        '  console.error("[ai-chat webui] "+tab+" 加载失败",e)}',
        'function load(tab,fn){try{var p=fn();if(p&&p.catch)p.catch(function(e){showTabErr(tab,e)})}catch(e){showTabErr(tab,e)}}',
        'function loadDash(){',
        '  return call("status").then(function(r){',
        '    if(!r||!r.ok){$("tab-dash").innerHTML="<div class=card>加载失败: "+esc(r&&r.error)+"</div>";return}',
        '    var s=r.status,h="";',
        '    h+="<div class=card><h2>运行状态</h2>";',
        '    h+="<div class=row><b>模型</b> "+esc(s.model)+" <span class=muted>"+esc(s.baseUrl)+"</span></div>";',
        '    h+="<div class=row><b>视觉(看图)</b> "+(s.vision?"<span class=ok>已开启</span>":"未开启")+" &nbsp; <b>回复逻辑</b> "+esc(s.groupMode)+"</div>";',
        '    h+="<div class=row><b>鉴权</b> "+esc(s.authMode)+" &nbsp; "+(s.authOk?"<span class=ok>"+esc(s.authNote)+"</span>":"<span class=err>未配置(需要填 API Key)</span>")+"</div>";',
        '    h+="<div class=row><b>群聊触发</b> "+esc(s.groupMode)+" &nbsp; <b>工具</b> "+s.tools+" 个 &nbsp; <b>正在思考</b> "+s.activeLlm+"</div>";',
        '    h+="<div class=row><b>工具网关</b> "+(s.gateway.running?"<span class=ok>运行中</span> "+esc(s.gateway.address||""):"<span class=err>未运行</span>")+"</div>";',
        '    h+="<div class=row><b>记忆</b> "+s.memory.facts+" 条 &nbsp; <b>会话</b> "+s.memory.sessions+" 个 &nbsp; <b>存储</b> "+esc(s.memory.backend)+"</div>";',
        '    h+="<div class=row><button class=\\"act gray\\" onclick=\\"doReload()\\">重载配置</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"doScan()\\">重新扫描工具</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"doRestartGw()\\">重启工具网关</button>";',
        '    h+="<button class=\\"act red\\" onclick=\\"doClearAll()\\">清空全部上下文</button></div>";',
        '    h+="<div id=opres class=muted></div></div>";',
        '    h+="<div class=card><h2>其它插件如何接入?</h2><div class=muted>任何插件都可以把自己的能力注册成工具:</div>";',
        '    var sample="network.post(\\"http://127.0.0.1:"+s.gateway.port+"/register\\", JSON.stringify(\\n{\\n  plugin: \\"my_plugin\\",\\n  tools: [{\\n    name: \\"sign_in\\",\\n    description: \\"给玩家签到\\",\\n    parameters: { type: \\"object\\", properties: { player: { type: \\"string\\" } }, required: [\\"player\\"] },\\n    callback: { type: \\"http\\", url: \\"http://127.0.0.1:18888/tool/sign_in\\" }\\n  }]\\n}))\\n";',
        '    h+="<pre>"+esc(sample)+"</pre></div>";',
        '    $("tab-dash").innerHTML=h;',
        '  })',
        '}',
        'function doReload(){call("reloadConfig").then(function(r){$("opres").innerHTML=r.ok?"<span class=ok>配置已重载</span>":"<span class=err>"+esc(r.error)+"</span>";loadDash()})}',
           'function doSaveToolsCfg(){',
           '  var a=document.getElementById("tc_logs"), b=document.getElementById("tc_mods");',
           '  call("toolsCfgSave",{logSources:a?a.value:"",modInstallTargets:b?b.value:""}).then(function(r){',
           '    var m=document.getElementById("tc_msg");',
           '    if(m) m.innerHTML=(r&&r.ok)?("<span class=ok>已保存：日志来源 "+r.count.logSources+" 条 / 装mod目标 "+r.count.modInstallTargets+" 条（立即生效）</span>"):("<span class=err>保存失败</span>");',
           '  });',
           '}',
        'function doScan(){call("scanTools").then(function(r){$("opres").innerHTML=r.ok?"<span class=ok>已扫描, 当前工具 "+r.tools+" 个</span>":"<span class=err>"+esc(r.error)+"</span>"})}',
        'function doRestartGw(){call("restartGateway").then(function(r){$("opres").innerHTML=r.ok?"<span class=ok>网关已重启</span>":"<span class=err>重启失败</span>"})}',
        'function doClearAll(){if(!confirm("确定清空所有会话上下文?"))return;call("clearContext",{}).then(function(){loadDash()})}',
        // ---- 工具 ----
           'function loadTools(){',
           '  return Promise.all([call("tools"), call("toolsCfg")]).then(function(aa){',
           '   var r=aa[0]||{}, c=aa[1]||{};',
           '   if(!r||r.ok===false){$("tab-tools").innerHTML="<div class=card>加载失败: "+esc(r&&r.error)+"</div>";return}',
        '    var h="<div class=card><h2>可用工具 ("+(r.tools||[]).length+")</h2>";',
        '    h+="<table><tr><th>名称</th><th>来源</th><th>说明</th></tr>";',
        '    (r.tools||[]).forEach(function(t){h+="<tr><td><code>"+esc(t.name)+"</code></td><td>"+esc(t.plugin)+"<div class=muted>"+esc(t.source)+"</div></td><td>"+esc(t.description)+"</td></tr>"});',
        '    h+="</table><div class=row style=\\"margin-top:10px\\"><button class=\\"act gray\\" onclick=\\"doScan()\\">重新扫描</button></div></div>";',
           '    h+="<div class=card><h2>服务端日志来源</h2><div class=muted>每行一条：key | 显示名 | 容器内路径（多个用逗号）</div>";',
           'h+="<div class=row><textarea id=tc_logs style=\\"width:100%;height:110px;font-family:monospace\\">"+esc((c.logSources||[]).map(function(x){return x.key+" | "+(x.name||"")+" | "+((x.paths||[]).join(","))}).join("\\n"))+"</textarea></div></div>";',
           '    h+="<div class=card><h2>允许安装 mod 的服务器</h2><div class=muted>每行一条：服务器名 | mods 目录 | 容器名（留空=功能关闭）</div>";',
           'h+="<div class=row><textarea id=tc_mods style=\\"width:100%;height:110px;font-family:monospace\\">"+esc((c.modInstallTargets||[]).map(function(x){return x.server+" | "+x.modsDir+" | "+(x.container||"")}).join("\\n"))+"</textarea></div>";',
           '    h+="<div class=row style=\\"margin-top:10px\\"><button class=\\"act\\" onclick=\\"doSaveToolsCfg()\\">保存这两项</button><span id=tc_msg class=muted></span></div></div>";',
        '    $("tab-tools").innerHTML=h;',
        '  })',
        '}',
        // ---- 记忆与会话 ----
        'function loadMem(){',
        '  return call("memory").then(function(r){',
        '    var h="<div class=card><h2>长期记忆 ("+r.stats.facts+")</h2>";',
        '    h+="<div class=row><input id=memtext placeholder=\\"写一条全局记忆, 例如: 本服每周六晚有活动\\"><button class=\\"act\\" onclick=\\"doAddMem()\\">添加</button>";',
        '    h+="<button class=\\"act red\\" onclick=\\"doClearMem()\\">清空记忆</button></div>";',
        '    h+="<table><tr><th>内容</th><th>范围</th><th>时间</th><th></th></tr>";',
        '    (r.facts||[]).forEach(function(f){',
        '      h+="<tr><td>"+esc(f.text)+"</td><td>"+esc(f.scope)+(f.owner?"<div class=muted>"+esc(f.owner)+"</div>":"")+"</td><td class=muted>"+esc(f.time)+"</td>";',
        '      h+="<td><button class=\\"act gray\\" data-id=\\""+esc(f.id)+"\\" onclick=\\"doForget(this)\\">删除</button></td></tr>";',
        '    });',
        '    h+="</table></div>";',
        '    h+="<div class=card><h2>会话上下文 ("+r.stats.sessions+")</h2><table><tr><th>会话</th><th>消息数</th><th>更新时间</th><th>AI</th><th></th></tr>";',
        '    (r.sessions||[]).forEach(function(s){',
        '      h+="<tr><td><code>"+esc(s.key)+"</code></td><td>"+s.messages+"</td><td class=muted>"+esc(s.updatedText)+"</td><td>"+(s.enabled?"开":"关")+"</td>";',
        '      h+="<td><button class=\\"act gray\\" data-key=\\""+esc(s.key)+"\\" onclick=\\"doView(this)\\">查看</button> ";',
        '      h+="<button class=\\"act gray\\" data-key=\\""+esc(s.key)+"\\" onclick=\\"doToggle(this)\\">开关</button> ";',
        '      h+="<button class=\\"act red\\" data-key=\\""+esc(s.key)+"\\" onclick=\\"doClearOne(this)\\">清空</button></td></tr>";',
        '    });',
        '    h+="</table></div><div id=memdetail></div>";',
        '    $("tab-mem").innerHTML=h;',
        '  })',
        '}',
        'function doAddMem(){var t=$("memtext").value;if(!t)return;call("saveMemory",{text:t,scope:"global"}).then(function(){loadMem()})}',
        'function doClearMem(){if(!confirm("确定清空所有长期记忆?"))return;call("clearMemory").then(function(){loadMem()})}',
        'function doForget(el){call("forgetFact",{id:el.dataset.id}).then(function(){loadMem()})}',
        'function doClearOne(el){call("clearContext",{key:el.dataset.key}).then(function(){loadMem()})}',
        'function doToggle(el){call("toggleSession",{key:el.dataset.key}).then(function(){loadMem()})}',
        'function doView(el){call("session",{key:el.dataset.key}).then(function(r){',
        '  var h="<div class=card><h2>会话 "+esc(el.dataset.key)+" 最近消息</h2>";',
        '  (r.messages||[]).forEach(function(m){h+="<div class=\\"msg "+esc(m.role)+"\\"><b>"+esc(m.name||m.role)+"</b>: "+esc(m.content)+"</div>"});',
        '  h+="</div>"; $("memdetail").innerHTML=h;',
        '})}',
        // ---- 模型(云 API 配置) ----
        'function loadLlm(){',
        '  return call("llmGet").then(function(r){',
        '    if(!r||!r.ok){$("tab-llm").innerHTML="<div class=card>加载失败</div>";return}',
        '    var l=r.llm;var h="";',
        '    h+="<div class=card><h2>大模型接口</h2>";',
        '    h+="<div class=row><b>接口地址 baseUrl</b><input id=lm_url value=\\""+esc(l.baseUrl)+"\\" style=\\"width:70%\\" placeholder=\\"https://api.deepseek.com/v1\\"></div>";',
        '    h+="<div class=muted style=\\"margin-left:8px\\">常见: DeepSeek https://api.deepseek.com/v1 ｜ OpenAI https://api.openai.com/v1 ｜ 硅基流动 https://api.siliconflow.cn/v1 ｜ 智谱 https://open.bigmodel.cn/api/paas/v4 ｜ Agnes https://api.deepseek.com/v1</div>";',
        '    h+="<div class=row><b>模型名</b><input id=lm_model value=\\""+esc(l.model)+"\\" placeholder=\\"deepseek-chat\\">";',
        '    h+="<b>鉴权方式</b><select id=lm_auth style=\\"width:auto\\">";',
        '    [["header","header (放到 Authorization 头)"],["query","query (放到 URL 参数)"],["none","none (不需要密钥)"]].forEach(function(x){h+="<option value=\\""+x[0]+"\\""+(l.authMode===x[0]?" selected":"")+">"+x[1]+"</option>"});',
        '    h+="</select></div>";',
        '    h+="<div class=row><b>API Key</b><input id=lm_key placeholder=\\""+(l.apiKeySet?("当前: "+esc(l.apiKeyMasked)+" (留空则不改)"):"还没有配置")+"\\" style=\\"width:52%\\">";',
        '    h+="<button class=\\"act gray\\" onclick=\\"clearKey()\\">清除密钥</button>";',
        '    h+="</div>";',
        '    h+="<div class=row><b>通用代理 relayBase</b><input id=lm_relay value=\\""+esc(l.relayBase)+"\\" style=\\"width:52%\\">";',
        '    h+="<span class=muted>接口强制要求 Content-Type: application/json 时填写；换供应商不用改</span></div>";',
        '    h+="<div class=row><b>工具最多轮数</b><input id=lm_rounds value=\\""+esc(l.maxToolRounds)+"\\" style=\\"width:70px\\"></div>";',
        '    h+="<div class=row><button class=\\"act\\" onclick=\\"saveLlm()\\">保存</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"testLlm()\\">测试连接</button>";',
        '    h+="<span id=lm_msg class=muted></span></div>";',
        '    h+="<div class=row><span class=muted>实际请求地址: </span><code>"+esc(r.effectiveUrl||"(未配置)")+"</code></div>";',
        '    h+="<div class=row>"+(r.authOk?"<span class=ok>鉴权已就绪</span>":"<span class=err>还没有 API Key，无法调用</span>")+"</div>";',
        '    h+="</div>";',
        '    h+="<pre id=lm_out class=muted style=\\"white-space:pre-wrap\\"></pre>";',
        '    $("tab-llm").innerHTML=h;',
        '  })',
        '}',
        'function saveLlm(){',
        '  call("llmSave",{baseUrl:$("lm_url").value,model:$("lm_model").value,authMode:$("lm_auth").value,apiKey:$("lm_key").value,relayBase:$("lm_relay").value,maxToolRounds:$("lm_rounds").value}).then(function(r){',
        '    $("lm_msg").innerHTML=r.ok?"<span class=ok>已保存并立即生效</span>":"<span class=err>保存失败</span>";',
        '    if(r.ok)loadLlm();',
        '  })',
        '}',
        'function clearKey(){call("llmClearKey").then(function(){loadLlm();setTimeout(function(){var m=$("lm_msg");if(m)m.innerHTML="<span class=ok>密钥已清除</span>"},60)})}',
        'function resetLlm(){call("llmReset").then(function(){loadLlm();setTimeout(function(){var m=$("lm_msg");if(m)m.innerHTML="<span class=ok>已恢复配置文件的值</span>"},60)})}',
        'function testLlm(){',
        '  $("lm_out").textContent="测试中…(会真的调一次模型)";',
        '  call("llmTest",{prompt:"你好，请用一句话打个招呼"}).then(function(r){',
        '    $("lm_out").textContent=r.ok?("✅ 连接成功 ("+r.ms+"ms)\\n模型回复: "+r.reply):("❌ 失败 ("+r.ms+"ms)\\n"+r.error);',
        '  })',
        '}',
        // ---- 指令知识库 ----
        'function loadKb(){',
        '  return call("kbGet").then(function(r){',
        '    if(!r||!r.ok){$("tab-kb").innerHTML="<div class=card>加载失败</div>";return}',
        '    var h="";',
        '    h+="<div class=card><h2>指令知识库</h2>";',
        '    h+="<div class=muted>每行一条: 指令 | 说明 | 关键词(逗号分隔) | 需要等级(0-3, 留空=按常规判定)<br>";',
        '    h+="指令里的 &lt;玩家&gt; / {player} 会当通配符, 用来判定这条指令该要几级。</div>";',
        '    h+="<div class=row><textarea id=kb_raw style=\\"width:100%;height:260px;font-family:monospace\\">"+esc(r.raw)+"</textarea></div>";',
        '    h+="<div class=row><b>写进工具描述的条数</b><input id=kb_n value=\\""+esc(r.inDescription)+"\\" style=\\"width:70px\\">";',
        '    h+="<button class=\\"act\\" onclick=\\"saveKb()\\">保存</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"resetKb()\\">恢复配置值</button>";',
        '    h+="<span id=kb_msg class=muted></span></div>";',
        '    if(r.errors&&r.errors.length){',
        '      h+="<div class=row><span class=err>发现 "+r.errors.length+" 处问题:</span></div><div class=muted>";',
        '      r.errors.forEach(function(e){h+="第 "+e.line+" 行: "+esc(e.reason)+" — "+esc(e.text)+"<br>"});',
        '      h+="</div>";',
        '    } else { h+="<div class=muted>格式检查通过, 共 "+r.entries.length+" 条</div>"; }',
        '    h+="</div>";',
        '    h+="<div class=card><h2>模型会查到什么(实时测试)</h2>";',
        '    h+="<div class=row><input id=kb_q placeholder=\\"输入玩家可能说的话, 例如: 加白名单 / 给物品 / 传送\\" style=\\"width:60%\\">";',
        '    h+="<button class=\\"act\\" onclick=\\"testKb()\\">测试</button></div>";',
        '    h+="<pre id=kb_out class=muted style=\\"white-space:pre-wrap\\"></pre></div>";',
        '    h+="<div class=card><h2>当前条目 ("+r.entries.length+")</h2><table><tr><th>指令</th><th>说明</th><th>关键词</th><th>等级</th></tr>";',
        '    r.entries.forEach(function(e){h+="<tr><td><code>"+esc(e.command)+"</code></td><td>"+esc(e.desc)+"</td><td>"+esc((e.keywords||[]).join(", "))+"</td><td>"+(e.level===null?"<span class=muted>常规</span>":lvTag(e.level))+"</td></tr>"});',
        '    h+="</table></div>";',
        '    $("tab-kb").innerHTML=h;',
        '  })',
        '}',
        'function saveKb(){',
        '  call("kbSave",{commandBook:$("kb_raw").value,commandBookInDescription:$("kb_n").value}).then(function(r){',
        '    if(!r.ok){$("kb_msg").innerHTML="<span class=err>保存失败</span>";return}',
        '    var bad=(r.errors||[]).length;',
        '    $("kb_msg").innerHTML=bad?("<span class=err>已保存, 但有 "+bad+" 处问题</span>"):"<span class=ok>已保存并立即生效</span>";',
        '    loadKb();',
        '    setTimeout(function(){var m=$("kb_msg");if(m)m.innerHTML="<span class=ok>已保存并立即生效</span>"},60);',
        '  })',
        '}',
        'function resetKb(){call("kbReset").then(function(){loadKb();setTimeout(function(){var m=$("kb_msg");if(m)m.innerHTML="<span class=ok>已恢复配置值</span>"},60)})}',
        'function testKb(){',
        '  call("kbTest",{query:$("kb_q").value}).then(function(r){',
        '    $("kb_out").textContent=r.ok?(r.text||"(无)"):"测试失败";',
        '  })',
        '}',
        // ---- 权限(按群分类) ----
        'function lvTag(n){var c=n>=3?"err":(n>=2?"warn":(n>=1?"ok":"muted"));return "<span class="+c+">"+n+"</span>"}',
        'function loadPerm(){',
        '  return call("permGet").then(function(r){',
        '    if(!r||!r.ok){$("tab-perm").innerHTML="<div class=card>加载失败</div>";return}',
        '    var o=r.overview,raw=r.raw,names=r.levelNames||{};',
        '    var h="";',
        '    h+="<div class=card><h2>等级说明</h2><div class=muted>0="+esc(names[0]||"")+" ｜ 1="+esc(names[1]||"")+" ｜ 2="+esc(names[2]||"")+" ｜ 3="+esc(names[3]||"")+"<br>群主自动最高等级, 其余所有人默认最低等级; 要给谁开权限就在下面按群填。</div></div>";',
        '    h+="<div class=card><h2>按群分类的等级</h2><div class=muted>每行一个群, 格式: 群号 | QQ:等级, QQ:等级</div>";',
        '    h+="<div class=row><textarea id=pm_scopes style=\\"width:100%;height:110px;font-family:monospace\\">"+esc(raw.groupScopes)+"</textarea></div>";',
        '    h+="<div class=row><b>全局等级(不限群)</b><input id=pm_users value=\\""+esc(raw.userLevels)+"\\" placeholder=\\"QQ:等级, QQ:等级\\" style=\\"width:100%\\"></div>";',
        '    h+="<div class=row><b>默认等级</b><input id=pm_def value=\\""+esc(raw.defaultLevel)+"\\" style=\\"width:70px\\">";',
        '    h+="<b>群主</b><input id=pm_owner value=\\""+esc(raw.groupOwnerLevel)+"\\" style=\\"width:70px\\">";',
        '    h+="<b>群管理</b><input id=pm_admin value=\\""+esc(raw.groupAdminLevel)+"\\" style=\\"width:70px\\">";',
        '    h+="<b>未列出指令</b><input id=pm_unknown value=\\""+esc(raw.unknownCommandLevel)+"\\" style=\\"width:70px\\"></div>";',
        '    h+="<div class=row><button class=\\"act\\" onclick=\\"savePerm()\\">保存</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"resetPerm()\\">恢复配置值</button><span id=pm_msg class=muted></span></div></div>";',
        '    h+="<div class=card><h2>谁是什么等级(实时生效)</h2>";',
        '    if(!o.groups.length) h+="<div class=muted>还没配置任何群。先在下面填, 或去插件配置里加「允许的群号」。</div>";',
        '    o.groups.forEach(function(g){',
        '      h+="<div style=\\"margin:10px 0;border-left:3px solid #888;padding-left:10px\\">";',
        '      h+="<b>群 "+esc(g.groupId)+"</b>"+(g.groupName?(" ("+esc(g.groupName)+")"):"")+"<br>";',
        '      h+="<span class=muted>群主 "+lvTag(g.owner)+" ｜ 群管理 "+lvTag(g.admin)+" ｜ 其他人 "+lvTag(g.others)+"</span>";',
        '      if(g.members.length){',
        '        h+="<table style=\\"margin-top:4px\\"><tr><th>成员</th><th>QQ</th><th>等级</th></tr>";',
        '        g.members.forEach(function(m){h+="<tr><td>"+esc(m.name||"-")+"</td><td>"+esc(m.qq)+"</td><td>"+lvTag(m.level)+" "+esc(names[m.level]||"")+"</td></tr>"});',
        '        h+="</table>";',
        '      } else { h+="<br><span class=muted>这个群没有单独配置的人</span>"; }',
        '      h+="</div>";',
        '    });',
        '    if(o.globalUsers.length){',
        '      h+="<div style=\\"margin-top:10px\\"><b>全局(所有群都生效)</b><table><tr><th>成员</th><th>QQ</th><th>等级</th></tr>";',
        '      o.globalUsers.forEach(function(m){h+="<tr><td>"+esc(m.name||"-")+"</td><td>"+esc(m.qq)+"</td><td>"+lvTag(m.level)+"</td></tr>"});',
        '      h+="</table></div>";',
        '    }',
        '    h+="</div>";',
        '    $("tab-perm").innerHTML=h;',
        '  })',
        '}',
        'function savePerm(){',
        '  call("permSave",{groupScopes:$("pm_scopes").value,userLevels:$("pm_users").value,defaultLevel:$("pm_def").value,groupOwnerLevel:$("pm_owner").value,groupAdminLevel:$("pm_admin").value,unknownCommandLevel:$("pm_unknown").value}).then(function(r){',
        '    $("pm_msg").innerHTML=r.ok?"<span class=ok>已保存并立即生效</span>":"<span class=err>保存失败</span>";',
        '    if(r.ok)loadPerm();',
        '  })',
        '}',
        'function resetPerm(){call("permReset").then(function(){loadPerm();setTimeout(function(){$("pm_msg").innerHTML="<span class=ok>已恢复配置值</span>"},60)})}',
        // ---- 回复逻辑 ----
        'function loadReply(){',
        '  return call("behaviorGet").then(function(r){',
        '    if(!r||!r.ok){$("tab-reply").innerHTML="<div class=card>加载失败</div>";return}',
        '    var b=r.behavior||{},pr=r.presets||[];',
        '    var hb=(r.humanize)||{},b2=hb;',
        '    var h="";',
        '    h+="<div class=card><h2>预设(点一下立即生效并保存)</h2><div class=row>";',
        '    pr.forEach(function(p){h+="<button class=\\"act gray\\" data-preset=\\""+esc(p.key)+"\\" onclick=\\"applyPreset(this)\\">"+esc(p.name)+"</button>"});',
        '    h+="</div><div class=muted>"+esc(pr.map(function(p){return p.name+"："+p.desc}).join("；"))+"</div>";',
        '    h+="<div id=presmsg class=muted style=\\"margin-top:6px\\"></div></div>";',
        '    h+="<div class=card><h2>细调</h2>";',
        '    h+="<div class=row><label><input type=checkbox id=r_enabled "+(b.enabled!==false?"checked":"")+"> 全局回复开关</label>";',
        '    h+="<label><input type=checkbox id=r_contAnyone "+(b.continuationAnyone?"checked":"")+"> 群内任何人都能接话(否则只有同一人)</label></div>";',
        '    h+="<div class=row><label><input type=checkbox id=r_nameTrigger "+(b.nameTrigger!==false?"checked":"")+"> 被叫名字也回</label>";',
        '    h+="<label><input type=checkbox id=r_replyTrigger "+(b.replyTrigger!==false?"checked":"")+"> 回复它也算叫它</label>";',
        '    h+="<span class=muted>两个都取消勾选 + 清空前缀/关键词 = 只有 @它 才会回</span></div>";',
        '    var opts={mention:"被@/叫名字/关键词才回",always:"每条都回",random:"被叫到必回, 否则按概率插话"};',
        '    h+="<div class=row><b>群聊模式</b> <select id=r_groupMode style=\\"width:auto\\">";',
        '    Object.keys(opts).forEach(function(k){h+="<option value=\\""+k+"\\""+(b.groupMode===k?" selected":"")+">"+k+" - "+opts[k]+"</option>"});',
        '    h+="</select></div>";',
        '    h+="<div class=row><b>触发前缀</b><input id=r_prefixes value=\\""+esc(asList(b.prefixes).join(","))+"\\" placeholder=\\"逗号分隔, 例如 ai,小助手\\"></div>";',
        '    h+="<div class=row><b>叫名字</b><input id=r_mention value=\\""+esc(asList(b.mentionNames).join(","))+"\\" placeholder=\\"额外的称呼, 逗号分隔\\"></div>";',
        '    h+="<div class=row><b>触发关键词</b><input id=r_keywords value=\\""+esc(asList(b.keywords).join(","))+"\\" placeholder=\\"出现这些词就回, 逗号分隔\\"></div>";',
        '    h+="<div class=row><b>连续对话窗口(秒)</b><input id=r_contWindow value=\\""+esc(b.continuationWindowSec)+"\\" style=\\"width:90px\\"> <span class=muted>刚回过后这段时间内接着说, 算作接话</span></div>";',
        '    h+="<div class=row><b>随机插话概率</b><input id=r_random value=\\""+esc(b.randomChance)+"\\" style=\\"width:90px\\"> <span class=muted>仅 random 模式</span></div>";',
        '    h+="<div class=row><b>回复冷却(秒)</b><input id=r_cooldown value=\\""+esc(b.cooldownSec)+"\\" style=\\"width:90px\\"> <b>每分钟上限</b><input id=r_perMin value=\\""+esc(b.maxRepliesPerMinute)+"\\" style=\\"width:90px\\"></div>";',
        '    h+="<div class=row><b>手动指令前缀</b><input id=r_manualPrefix value=\\""+esc(asList(b.manualCommandPrefixes).join(","))+"\\" placeholder=\\"！,!,/\\" style=\\"width:130px\\"> <b>命中后</b><select id=r_manualAction style=\\"width:auto\\">";',
        '    [["no-tools","不给AI工具(推荐, 仍可回复)"],["skip","完全不回复"],["off","不特殊处理"]].forEach(function(x){h+="<option value=\\""+x[0]+"\\""+((b.manualCommandAction||"no-tools")===x[0]?" selected":"")+">"+x[1]+"</option>"});',
        '    h+="</select></div>";',
        '    h+="<div class=row><b>额外过滤正则</b><input id=r_stripRegex value=\\""+esc(hb.stripRegex||"")+"\\" placeholder=\\"每行一条正则, 例如 《.*?》\\" style=\\"width:100%\\"><span class=muted>用于过滤模型泄漏的标签等</span></div>";',
        '    h+="<div class=row><label><input type=checkbox id=r_splitNl "+(hb.splitOnNewline!==false?"checked":"")+"> 换行即分段(模型写的每一行单独发一条消息)</label></div>";',
        '    h+="<div class=row><button class=\\"act\\" onclick=\\"saveReply()\\">保存</button>";',
        '    h+="<button class=\\"act gray\\" onclick=\\"resetReply()\\">恢复配置文件的值</button>";',
        '    h+="<span class=muted>改完立即生效, 不用重启</span></div></div>";',
        '    h+="<div class=card><h2>决策模拟器</h2><div class=muted>输入一句话, 看看机器人会不会回、为什么</div>";',
        '    h+="<div class=row style=\\"margin-top:8px\\"><input id=t_text placeholder=\\"例如: ai 服务器有几个人\\"></div>";',
        '    h+="<div class=row><label><input type=checkbox id=t_at> @了机器人</label>";',
        '    h+="<label><input type=checkbox id=t_reply> 回复了机器人</label>";',
        '    h+="<label><input type=checkbox id=t_cont> 刚聊过(在窗口内)</label>";',
        '    h+="<input id=t_group placeholder=\\"群号(可留空)\\" style=\\"width:140px\\"></div>";',
        '    h+="<div class=row><button class=\\"act\\" onclick=\\"doTestReply()\\">测试</button><span id=t_res class=muted></span></div></div>";',
        '    $("tab-reply").innerHTML=h;',
        '  })',
        '}',
        'function applyPreset(el){call("behaviorPreset",{key:el.dataset.preset}).then(function(r){',
        '  if(!r.ok){$("presmsg").innerHTML="<span class=err>"+esc(r.error)+"</span>";return}',
        '  loadReply();',
        '  setTimeout(function(){$("presmsg").innerHTML="<span class=ok>已应用预设</span>"},50);',
        '})}',
        'function val(id,def){var e=document.getElementById(id);return e?e.value:(def===undefined?"":def)}',
        'function chk(id,def){var e=document.getElementById(id);return e?!!e.checked:(def===undefined?false:def)}',
        'function saveReply(){',
        '  var b={enabled:chk("r_enabled",true),groupMode:val("r_groupMode"),continuationAnyone:chk("r_contAnyone"),',
        '    nameTrigger:chk("r_nameTrigger",true),replyTrigger:chk("r_replyTrigger",true),',
        '    continuationWindowSec:val("r_contWindow"),cooldownSec:val("r_cooldown"),maxRepliesPerMinute:val("r_perMin"),',
        '    randomChance:val("r_random"),prefixes:val("r_prefixes"),keywords:val("r_keywords"),mentionNames:val("r_mention"),',
        '    manualCommandPrefixes:val("r_manualPrefix"),manualCommandAction:val("r_manualAction","no-tools")};',
        '  var hum={stripRegex:val("r_stripRegex"),splitOnNewline:chk("r_splitNl",true)};',
        '  var pm=document.getElementById("presmsg");',
        '  if(pm)pm.innerHTML="<span class=muted>保存中…</span>";',
        '  call("behaviorSave",{behavior:b,humanize:hum}).then(function(r){',
        '    if(pm)pm.innerHTML=r.ok?"<span class=ok>已保存并生效</span>":"<span class=err>保存失败: "+esc(JSON.stringify(r))+"</span>";',
        '  }).catch(function(e){ if(pm)pm.innerHTML="<span class=err>保存请求出错: "+esc(String(e&&e.message||e))+"</span>"; });',
        '}',
        'function resetReply(){call("behaviorReset").then(function(){loadReply();setTimeout(function(){$("presmsg").innerHTML="<span class=ok>已恢复配置值</span>"},50)})}',
        'function doTestReply(){',
        '  var p={text:$("t_text").value,at:$("t_at").checked,replyBot:$("t_reply").checked,continuation:$("t_cont").checked,groupId:$("t_group").value};',
        '  call("behaviorTest",p).then(function(r){',
        '    if(!r.ok){$("t_res").innerHTML="<span class=err>"+esc(r.error)+"</span>";return}',
        '    var d=r.decision||{};',
        '    var head=d.reply?"<span class=ok>会回复</span>":"<span class=err>不回复</span>";',
        '    $("t_res").innerHTML=head+" &nbsp;原因: "+esc(d.reason)+" <span class=muted>(解析到: "+esc(r.parsedText)+")</span>";',
        '  })',
        '}',
        // ---- 人设 ----
        'function loadPersona(){return call("getPersona").then(function(r){var p=r.persona||{};',
        '  var h="<div class=card><h2>人设 (保存后立即生效)</h2>";',
        '  h+="<div class=row><b>名字</b></div><input id=p_name value=\\""+esc(p.name)+"\\">";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>身份</b></div><textarea id=p_identity>"+esc(p.identity)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>性格</b></div><textarea id=p_personality>"+esc(p.personality)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>说话风格</b></div><textarea id=p_speakingStyle>"+esc(p.speakingStyle)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>背景</b></div><textarea id=p_background>"+esc(p.background)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>额外规则</b></div><textarea id=p_extraRules>"+esc(p.extraRules)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><b>示例对话</b>(写几段 用户:/你: 能明显影响风格)</div><textarea id=p_exampleDialogue>"+esc(p.exampleDialogue)+"</textarea>";',
        '  h+="<div class=row style=\\"margin-top:12px\\"><button class=\\"act\\" onclick=\\"doSavePersona()\\">保存</button><span id=pres class=muted></span></div></div>";',
        '  $("tab-persona").innerHTML=h;})}',
        'function doSavePersona(){',
        '  var o={name:$("p_name").value,identity:$("p_identity").value,personality:$("p_personality").value,',
        '         speakingStyle:$("p_speakingStyle").value,background:$("p_background").value,extraRules:$("p_extraRules").value,exampleDialogue:$("p_exampleDialogue").value};',
        '  call("savePersona",o).then(function(r){$("pres").innerHTML=r.ok?"<span class=ok>已保存</span>":"<span class=err>"+esc(r.error)+"</span>"})}',
        // ---- 测试 ----
        'function loadTest(){',
        '  var h="<div class=card><h2>对话测试</h2><div class=muted>直接走真实的大模型 + 工具链路, 不影响群里的上下文。</div>";',
        '  h+="<div class=row style=\\"margin-top:10px\\"><input id=tprompt placeholder=\\"问点什么, 例如: 现在服务器上有几个人?\\"><button class=\\"act\\" onclick=\\"doTest()\\">发送</button></div>";',
        '  h+="<div id=tres></div></div>";',
        '  $("tab-test").innerHTML=h;',
        '}',
        'function doTest(){var q=$("tprompt").value;if(!q)return;$("tres").innerHTML="<div class=muted>思考中...</div>";',
        '  call("test",{prompt:q}).then(function(r){',
        '    if(!r.ok){$("tres").innerHTML="<div class=err>"+esc(r.error)+"</div>";return}',
        '    var h="<pre>"+esc(r.content)+"</pre>";',
        '    if(r.toolCalls&&r.toolCalls.length)h+="<div class=muted>调用了工具: "+esc(r.toolCalls.join(", "))+"</div>";',
        '    $("tres").innerHTML=h;})}',
        // ---- 初始化 ----
        'whenBridgeReady(function(){load("dash",loadDash);load("test",loadTest);});',
        '</script>',
        '</body>',
        '</html>'
    ].join('\n');
}

/** 在菜单系统就绪时注册页面 */
function register(pluginMenu) {
    try {
        pluginMenu.registerGroup('ai_chat', 'AI 对话助手', 'RobotOutlined', null, true, 60, false);
        pluginMenu.register(
            'panel',
            '/pages/ai_chat/panel',
            'AI 对话助手',
            'ConsoleSqlOutlined',
            onAction,
            pageHtml,
            'ai_chat',
            true,
            null,
            false,
            '拟人化大模型对话与工具调用管理面板'
        );
        logger.info('[ai-chat] 已注册 WebUI 菜单: AI 对话助手');
        return true;
    } catch (e) {
        logger.warning('[ai-chat] 注册 WebUI 菜单失败: {0}', (e && e.message) || e);
        return false;
    }
}

module.exports = {
    register: register,
    onAction: onAction,
    pageHtml: pageHtml,
    listSessions: listSessions
};
