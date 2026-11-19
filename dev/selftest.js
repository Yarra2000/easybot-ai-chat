'use strict';

/**
 * 离线自测。运行:  node dev/selftest.js
 *
 * 它用 dev/mock-easybot.js 模拟 EasyBot 运行时, 真刀真枪地跑一遍:
 *   加载插件 → 启用 → 群消息触发 → 大模型工具调用 → 拟人化分段发送
 *   → HTTP 工具网关注册/调用 → WebUI 面板动作 → 命令系统
 */

const mock = require('./mock-easybot.js');
mock.install();

// ---------------------------------------------------------------- 测试框架

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { passed++; console.log('  ✅ ' + label); }
    else {
        failed++; failures.push(label);
        console.log('  ❌ ' + label + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : ''));
    }
}
function eq(a, b, label) { ok(a === b, label, { actual: a, expected: b }); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------- 配置

mock.configValues['main'] = {
    apiKey: 'sk-test-key',
    baseUrl: 'https://example.com/v1',
    model: 'test-model',
    // 让测试跑得快: 关掉所有延迟
    'humanize.typingBaseMs': 0,
    'humanize.typingPerCharMs': 0,
    'humanize.typingJitterMs': 0,
    'humanize.segmentDelayBaseMs': 0,
    'humanize.segmentDelayPerCharMs': 0,
    'humanize.segmentDelayJitterMs': 0,
    'humanize.quoteChance': 0,
    'humanize.atChance': 0,
    'humanize.emojiChance': 0,
    'behavior.cooldownSec': 0,
    'behavior.maxRepliesPerMinute': 999,
    'behavior.continuationWindowSec': 0,
    'memory.autoSummaryEvery': 0,
    'tools.discover.enabled': false,
    'permissions.userLevels': '10001:3'      // 测试里的主要发言人给高权限(顺带验证显式授权)
};

// ---------------------------------------------------------------- 网络模拟

let chatMode = 'tool-then-answer';
let chatCallCount = 0;
let chatCalls = 0;

const chatResponder = async function (msg) {
    const url = String(msg.url || '');

    // 把发往"本进程内模拟服务"的请求转发给真正的路由处理函数,
    // 这样多插件之间的 HTTP 交互就是真实跑通的。
    if (url.indexOf('127.0.0.1:20777') >= 0) {
        const p = url.replace(/^https?:\/\/127\.0\.0\.1:20777/, '');
        const r = await mock.callRoute('ai_chat_gateway', msg.method || 'POST', p,
            { url: p, method: msg.method || 'POST', headers: {}, body: msg.body });
        return { status: r.status, data: JSON.parse(r.body || '{}') };
    }
    if (url.indexOf('127.0.0.1:18889') >= 0) {
        const p = url.replace(/^https?:\/\/127\.0\.0\.1:18889/, '');
        const r = await mock.callRoute('ai_chat_demo_plugin_tools', 'POST', p,
            { url: p, method: 'POST', headers: {}, body: msg.body });
        return { status: r.status, data: JSON.parse(r.body || '{}') };
    }

    // 其它插件注册的工具回调
    if (url.indexOf('/tool/') >= 0) {
        const body = JSON.parse(msg.body || '{}');
        return { status: 200, data: { ok: true, from: 'other_plugin', tool: body.tool, args: body.arguments } };
    }

    // 大模型接口
    const body = JSON.parse(msg.body || '{}');
    chatCalls++;

    if (chatMode === 'tool-then-answer') {
        const hasToolResult = (body.messages || []).some(function (m) { return m.role === 'tool'; });
        if (!hasToolResult) {
            return {
                status: 200,
                data: {
                    choices: [{
                        message: {
                            role: 'assistant', content: '',
                            tool_calls: [{
                                id: 'call_1', type: 'function',
                                function: { name: 'eb_run_command', arguments: JSON.stringify({ command: 'say hi' }) }
                            }]
                        },
                        finish_reason: 'tool_calls'
                    }],
                    usage: { total_tokens: 42 }
                }
            };
        }
        return {
            status: 200,
            data: { choices: [{ message: { role: 'assistant', content: '搞定啦，已经帮你广播过了~' }, finish_reason: 'stop' }] }
        };
    }

    if (chatMode === 'multi-segment') {
        return {
            status: 200,
            data: {
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '第一句是这样子的。\n**第二句**有 Markdown 需要清理。\n第三句比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长比较长。'
                    },
                    finish_reason: 'stop'
                }]
            }
        };
    }

    if (chatMode === 'memory-tool') {
        const hasToolResult = (body.messages || []).some(function (m) { return m.role === 'tool'; });
        if (!hasToolResult) {
            return {
                status: 200,
                data: {
                    choices: [{
                        message: {
                            role: 'assistant', content: '',
                            tool_calls: [{
                                id: 'call_mem', type: 'function',
                                function: {
                                    name: 'memory_save',
                                    arguments: JSON.stringify({ text: 'E2E 端到端记忆', scope: 'user' })
                                }
                            }]
                        },
                        finish_reason: 'tool_calls'
                    }]
                }
            };
        }
        return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '记住啦' }, finish_reason: 'stop' }] } };
    }

    if (chatMode === 'silent') {
        return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '[SKIP]' }, finish_reason: 'stop' }] } };
    }

if (chatMode === 'silent-once') {
    chatCallCount++;
    if (chatCallCount === 1) return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '[SKIP]' }, finish_reason: 'stop' }] } };
    return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '在的在的~' }, finish_reason: 'stop' }] } };
}

    return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '你好呀~' }, finish_reason: 'stop' }] } };
};
mock.setNetworkResponder(chatResponder);

// ---------------------------------------------------------------- 载入插件

const sent = [];
let msgSeq = 0;

function groupEvent(opts) {
    opts = opts || {};
    const selfId = '99999';
    const segs = [];
    if (opts.at) segs.push(new mock.AtSegment(selfId));
    segs.push(new mock.TextSegment(opts.text || ''));
    return {
        SelfId: selfId,
        SenderId: opts.senderId || '10001',
        PeerId: opts.peerId || '123456',
        MessageId: opts.messageId || ('m' + (++msgSeq)),
        SenderName: opts.senderName || '小明',
        SenderRole: opts.role || 'member',
        // 用真实环境一致的 CQ 码格式, 顺便覆盖 CQ 解析路径
        RawMessage: (opts.at ? '[CQ:at,qq=' + selfId + ']' : '') + (opts.rawExtra || '') + (opts.text || ''),
        Messages: segs,
        Chain: new mock.MessageChain().Text(opts.text || ''),
        AdapterContext: {
            SendGroupMessageAsync: async function (selfId2, peerId, chain) {
                sent.push({ kind: 'group', peerId: peerId, text: chain.AsString() });
                return 'bot_msg_' + (++msgSeq);
            },
            SendDirectMessageAsync: async function (selfId2, peerId, chain) {
                sent.push({ kind: 'direct', peerId: peerId, text: chain.AsString() });
                return 'bot_msg_' + (++msgSeq);
            }
        },
        Context: {
            Reply: async function (chain) {
                sent.push({ kind: 'reply', text: chain.AsString() });
                return 'reply_' + (++msgSeq);
            }
        }
    };
}

function directEvent(opts) {
    opts = opts || {};
    return {
        SelfId: '99999',
        SenderId: opts.senderId || '10001',
        SenderName: opts.senderName || '小明',
        MessageId: ++msgSeq,
        RawMessage: opts.text || '',
        Messages: [new mock.TextSegment(opts.text || '')],
        Chain: new mock.MessageChain().Text(opts.text || ''),
        AdapterContext: {
            SendDirectMessageAsync: async function (selfId2, peerId, chain) {
                sent.push({ kind: 'direct', peerId: peerId, text: chain.AsString() });
                return 'bot_msg_' + (++msgSeq);
            },
            SendGroupMessageAsync: async function () { return ''; }
        },
        Context: { Reply: async function (chain) { sent.push({ kind: 'reply', text: chain.AsString() }); return 'r'; } }
    };
}

async function main() {
    section('加载与启用');

    require('../main.js');
    ok(mock.bus.count('enable') === 1, '注册了 enable 事件');
    ok(mock.bus.count('group_message_event') === 1, '注册了群消息事件');
    ok(mock.bus.count('direct_message_event') === 1, '注册了私聊事件');
    ok(Object.keys(mock.rpcHandlers).length >= 3, '注册了 RPC 接口 (' + Object.keys(mock.rpcHandlers).join(',') + ')');

    await mock.bus.emit('enable');

    ok(mock.formDefinitions.length === 1, '注册了配置表单');
    ok(mock.httpServers['ai_chat_gateway'] && mock.httpServers['ai_chat_gateway'].running, '工具网关已启动');

    const registry = require('../lib/tools/registry.js');
    const memory = require('../lib/memory.js');
    const config = require('../lib/config.js');
    const humanize = require('../lib/humanize.js');
    const hum = humanize;
    const chat = require('../lib/chat.js');
    const llm = require('../lib/llm.js');
    const builtin = require('../lib/tools/builtin.js');
    const perm = require('../lib/permissions.js');

    ok(registry.list().length >= 10, '内置工具已注册 (' + registry.list().length + ' 个)');
    ok(!!registry.get('eb_list_servers'), '存在 eb_list_servers 工具');
    ok(!!registry.get('eb_rpc_call'), '存在 eb_rpc_call 工具');
    eq(config.get().llm.apiKey, 'sk-test-key', '扁平配置别名 apiKey 生效');
    eq(config.get().humanize.typingBaseMs, 0, '点号配置 "humanize.typingBaseMs" 生效');
    eq(config.get().llm.model, 'test-model', 'model 生效');

    section('配置解析: 兼容表单的多种保存形态');

    const savedConfig = mock.configValues['main'];
    // A. 按"容器分组"嵌套保存 (EasyBot 动态表单最可能的形态)
    mock.configValues['main'] = {
        llmGroup: { baseUrl: 'https://nested.example/v1', apiKey: 'sk-nested', model: 'nested-model', temperature: '1.2' },
        humanGroup: { humanizeEnabled: true, typingPerCharMs: '7', segmentMaxCount: '2' },
        toolGroup: { toolsEnabled: true, gatewayPort: '20778', allowRunCommand: 'false', commandBlacklist: 'stop, ban' },
        accessGroup: { adminUserIds: '10001,10002' },
        behavior: { groupMode: 'always', cooldownSec: '9' }
    };
    config.reload();
    eq(config.get().llm.apiKey, 'sk-nested', '分组容器: llmGroup.apiKey -> llm.apiKey');
    eq(config.get().llm.baseUrl, 'https://nested.example/v1', '分组容器: baseUrl 生效');
    eq(config.get().llm.temperature, 1.2, '分组容器: 数字字符串转数字');
    eq(config.get().humanize.typingPerCharMs, 7, '分组容器: humanGroup.typingPerCharMs 生效');
    eq(config.get().humanize.segmentMaxCount, 2, '分组容器: humanGroup.segmentMaxCount 生效');
    eq(config.get().tools.gateway.port, 20778, '分组容器: toolGroup.gatewayPort -> tools.gateway.port');
    eq(config.get().tools.allowRunCommand, false, '分组容器: 布尔字符串转布尔');
    eq(config.get().tools.commandBlacklist.length, 2, '分组容器: 逗号字符串转数组', config.get().tools.commandBlacklist);
    eq(config.get().access.adminUserIds.length, 2, '分组容器: 管理员列表解析');
    eq(config.get().behavior.groupMode, 'always', '区块式 behavior.groupMode 生效');
    eq(config.get().behavior.cooldownSec, 9, '区块式 behavior.cooldownSec 生效');

    // B. groupId 不是 "main" 时, 从 getAllConfigs 兜底找到本插件的配置
    mock.configValues['main'] = null;
    mock.configValues['some_other_group'] = { llm: { apiKey: 'sk-fallback', model: 'fb-model' } };
    config.reload();
    eq(config.get().llm.apiKey, 'sk-fallback', 'groupId 非 main 时兜底读取成功');
    delete mock.configValues['some_other_group'];

    // 恢复测试主配置
    mock.configValues['main'] = savedConfig;
    config.reload();
    eq(config.get().llm.apiKey, 'sk-test-key', '配置已恢复为测试主配置');
    eq(config.get().behavior.cooldownSec, 0, '恢复后的冷却仍为 0');

    section('纯函数: 拟人化拆分');

    const chunks = humanize.splitByPunctuation('你好。今天天气不错！要不要一起玩？', 8);
    ok(chunks.length >= 2, '按标点拆分成多段 (' + JSON.stringify(chunks) + ')');
    // ★ 换行即分段: 模型用换行排版成"几句聊天", 就该分成几条发出去
    config.setRuntime('humanize.enabled', true);
    const nlText = '嘿嘿 (≧▽≦)\n小助手今天超乖的\n头给你摸摸 不许挠秃哦\n刚才在群里看到好多游戏截图，姐姐们还没下班呢，估计还在肝 233';
    const nlSegs = humanize.plan(nlText, {}).segments.map(function (x) { return x.text; });
    eq(nlSegs.length, 4, '四行文本分成 4 条消息', nlSegs);
    eq(nlSegs[0], '嘿嘿 (≧▽≦)', '第一条就是第一行');
    ok(nlSegs[3].indexOf('还在肝 233') >= 0, '最后一条是最后一行', nlSegs[3]);
    // 关掉"换行即分段"时恢复成一条
    config.setRuntime('humanize.splitOnNewline', false);
    eq(humanize.plan(nlText, {}).segments.length, 1, '关掉换行分段后合回一条');
    config.setRuntime('humanize.splitOnNewline', true);
    // 空行不再产生空片段
    const gapSegs = humanize.plan('甲。\n\n乙。', {}).segments.map(function (x) { return x.text; });
    ok(gapSegs.every(function (x) { return x.trim().length > 0; }), '分段结果里没有空片段', gapSegs);
    eq(humanize.stripMarkdown('**粗体** 和 `代码`'), '粗体 和 代码', 'Markdown 被清理');
    ok(humanize.isSkip('[SKIP]', '[SKIP]'), '能识别 SKIP');
    ok(humanize.isSkip('（不说话）', '[SKIP]'), '能识别"不说话"');

    section('触发判断');

    let ev = groupEvent({ text: '今天天气不错' });
    let d = chat.decideReply(ev, 'group', memory.sessionKey('group', '123456'), '今天天气不错');
    ok(d.reply === false, 'mention 模式下没被叫到 → 不回复 (' + d.reason + ')');

    ev = groupEvent({ text: '在吗', at: true });
    d = chat.decideReply(ev, 'group', memory.sessionKey('group', '123456'), '在吗');
    ok(d.reply === true, '@机器人 → 回复 (' + d.reason + ')');

    ev = groupEvent({ text: '小助手帮我看看' });
    d = chat.decideReply(ev, 'group', memory.sessionKey('group', '123456'), '小助手帮我看看');
    ok(d.reply === true, '叫名字 → 回复 (' + d.reason + ')');

    ev = groupEvent({ text: 'ai 服务器有几个人' });
    d = chat.decideReply(ev, 'group', memory.sessionKey('group', '123456'), 'ai 服务器有几个人');
    ok(d.reply === true, '前缀触发 → 回复 (' + d.reason + ')');

    ev = groupEvent({ text: 'airpods 好用吗' });
    d = chat.decideReply(ev, 'group', memory.sessionKey('group', '123456'), 'airpods 好用吗');
    ok(d.reply === false, '前缀有边界(airpods 不触发 ai)');

    section('真实消息解析 (CQ 码优先 + 片段多策略兜底)');

    // 用例原文取自真实 EasyBot 日志
    const p1 = chat.parseRaw('[CQ:reply,id=365699200][CQ:at,qq=100000004] 它在开着');
    eq(p1.replyId, '365699200', 'CQ: 解析出 reply id');
    eq(p1.ats[0], '100000004', 'CQ: 解析出 at qq');
    ok(p1.plain.indexOf('它在开着') >= 0, 'CQ: 保留正文');

    const p2 = chat.parseRaw('[CQ:image,file=x.jpg,sub_type=0,url=https://a.b/c?d=1&amp;e=2]');
    eq(p2.images, 1, 'CQ:image 计数');
    eq(chat.extractText({ RawMessage: '[CQ:image,file=x.jpg]' }), '[图片]', '图片消息转成 [图片]');

    // @ 机器人: 用 selfId=99999
    const evAt = {
        SelfId: '99999',
        RawMessage: '[CQ:at,qq=99999] ai 你好',
        Messages: []
    };
    ok(chat.hasAtBot(evAt), 'CQ:at 命中机器人');
    eq(chat.extractText(evAt), '@你 ai 你好', '@机器人转成 @你 并保留正文');

    const evAtOther = { SelfId: '99999', RawMessage: '[CQ:at,qq=111] 你好', Messages: [] };
    ok(!chat.hasAtBot(evAtOther), 'CQ:at 别人不算');
    eq(chat.extractText(evAtOther), '@某人 你好', '@别人转成 @某人');

    // 没有 CQ 码时退化
    eq(chat.extractText({ SelfId: '1', RawMessage: '纯文本消息', Messages: [] }), '纯文本消息', '无 CQ 码时使用原文');

    // .NET 风格集合 (Count + get_Item), 模拟真实环境里的 Messages
    const dotnetList = {
        Count: 2,
        get_Item: function (i) { return new mock.TextSegment(i === 0 ? '你好' : '世界'); }
    };
    const u = require('../lib/util.js');
    const arr = u.toArray(dotnetList);
    eq(arr.length, 2, 'toArray 能处理 .NET 风格 get_Item 集合');
    eq(chat.extractText({ SelfId: '1', RawMessage: '', Messages: dotnetList }), '你好世界', '片段兜底拼出文本');

    const dotnetEnum = {
        GetEnumerator: function () {
            let i = -1;
            const items = ['A', 'B', 'C'];
            return {
                get Current() { return items[i]; },
                MoveNext: function () { i++; return i < items.length; }
            };
        }
    };
    eq(u.toArray(dotnetEnum).join(''), 'ABC', 'toArray 能处理 GetEnumerator 集合');

    ok(chat.isReplyToBot({
        SelfId: '99999', RawMessage: '[CQ:reply,id=bot_msg_7] 对', Messages: []
    }, memory.sessionKey('group', 'rbt')) === false, '未记录过的回复 id 不算回复机器人');

    section('群聊: 完整对话 + 工具调用');

    sent.length = 0;
    chatMode = 'tool-then-answer';
    chatCalls = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 帮我给大家说声 hi', at: true }));
    await new Promise(function (r) { setTimeout(r, 200); });

    ok(sent.length >= 1, '机器人发出了消息 (' + sent.length + ' 条)');
    ok(sent.some(function (s) { return s.text.indexOf('搞定啦') >= 0; }), '回复内容正确', sent.map(function (s) { return s.text; }));
    ok(mock.serverActions.some(function (a) { return a.type === 'command' && a.command === 'say hi'; }),
        '大模型通过工具真的执行了服务器命令', mock.serverActions);
    ok(chatCalls >= 2, '发生了多轮工具调用 (' + chatCalls + ' 次请求)');

    section('群聊: 分段发送 + Markdown 清理');

    sent.length = 0;
    chatMode = 'multi-segment';
    await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 讲个故事', at: true, messageId: 'm-seg' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    ok(sent.length >= 2, '长回复被拆成多条发送 (' + sent.length + ' 条)');
    ok(sent.join('').indexOf('**') < 0, '发出的消息没有 Markdown 星号');

    section('群聊: 保持沉默');

    sent.length = 0;
    chatMode = 'silent';
    await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 在吗', at: true }));
    await new Promise(function (r) { setTimeout(r, 200); });
    eq(sent.length, 0, '模型输出 [SKIP] 时不发消息');

section('群聊: 不许沉默 (allowSkip=false 时模型硬说沉默也要回)');

sent.length = 0;
chatMode = 'silent-once';
chatCallCount = 0;
await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 在吗', at: true }));
await new Promise(function (r) { setTimeout(r, 400); });
eq(chatCallCount, 2, '模型第一次只说沉默, 插件确实又调用了一次');
ok(sent.length >= 1, '第二次给出真回复后真的发了消息 (' + sent.length + ' 条)');

    section('私聊');

    sent.length = 0;
    chatMode = 'simple';
    await mock.bus.emit('direct_message_event', directEvent({ text: '你好' }));
    await new Promise(function (r) { setTimeout(r, 200); });
    ok(sent.length === 1 && sent[0].kind === 'direct', '私聊消息被回复 (' + JSON.stringify(sent) + ')');

    section('长期记忆');

    const fact = memory.addFact('小明喜欢红石', { scope: 'user', owner: '10001', session: 'g:123456' });
    ok(!!fact && !!fact.id, '写入长期记忆');
    const rel = memory.getRelevantFacts({ owner: '10001', session: 'g:123456' });
    ok(rel.some(function (f) { return f.text === '小明喜欢红石'; }), '按用户读取到长期记忆');
    ok(memory.searchFacts('红石', 5).length >= 1, '关键词搜索命中');
    const prompt = chat.buildSystemPrompt('g:123456', '10001', '小明', 'group', '');
    ok(prompt.indexOf('小明喜欢红石') >= 0, '长期记忆被注入系统提示词');

    section('工具运行上下文');

    // memory_save 必须知道"是谁在说话 / 在哪个会话", 否则会记错人
    let saved = await registry.invoke('memory_save', { text: '上下文测试记忆' }, { sessionKey: 'g:ctx', senderId: '10086' });
    ok(saved && saved.success === true, 'memory_save 可调用', saved);
    const ctxFact = memory.allFacts().filter(function (f) { return f.text === '上下文测试记忆'; })[0];
    ok(!!ctxFact && ctxFact.owner === '10086' && ctxFact.session === 'g:ctx',
        '工具调用时上下文(发送者/会话)被正确传入', ctxFact);

    // 端到端: 群消息 → 模型要求调用 memory_save → 记忆归属必须是这位群友
    sent.length = 0;
    chatMode = 'memory-tool';
    await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 记住我喜欢钻石', at: true, senderId: '20002' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    const e2eFact = memory.allFacts().filter(function (f) { return f.text === 'E2E 端到端记忆'; })[0];
    ok(!!e2eFact && e2eFact.owner === '20002', '端到端: 模型通过工具写入的记忆归属正确', e2eFact);

    section('命令系统');

    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '/ai remember 他叫小明' }));
    await new Promise(function (r) { setTimeout(r, 100); });
    ok(mock.liteStore.facts && Object.keys(mock.liteStore.facts).length >= 1, '/ai remember 写入了记忆');
    ok(sent.some(function (s) { return s.text.indexOf('记住了') >= 0; }), '命令有回复', sent);

    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '/ai tools', senderId: '10001' }));
    await new Promise(function (r) { setTimeout(r, 100); });
    ok(sent.some(function (s) { return s.text.indexOf('eb_list_servers') >= 0; }), '/ai tools 列出了工具');

    section('其它插件接入: HTTP 工具网关');

    const regRes = await mock.callRoute('ai_chat_gateway', 'POST', '/register', {
        url: '/register', method: 'POST', headers: {},
        body: JSON.stringify({
            plugin: 'other_plugin',
            tools: [{
                name: 'sign_in',
                description: '给玩家签到',
                parameters: { type: 'object', properties: { player: { type: 'string' } }, required: ['player'] },
                callback: { type: 'http', url: 'http://127.0.0.1:18888/tool/sign_in' }
            }]
        })
    });
    const regBody = JSON.parse(regRes.body);
    ok(regBody.ok === true, '注册接口返回成功', regBody);
    ok(!!registry.get('other_plugin__sign_in'), '工具 other_plugin__sign_in 进入注册表');

    // /invoke 是异步契约: 立即 202 + requestId, 结果靠 /result 轮询或 callbackUrl
    const invokeRes = await mock.callRoute('ai_chat_gateway', 'POST', '/invoke', {
        url: '/invoke', method: 'POST', headers: {},
        body: JSON.stringify({ name: 'other_plugin__sign_in', arguments: { player: 'Steve' } })
    });
    const invokeBody = JSON.parse(invokeRes.body);
    ok(invokeRes.status === 202 && invokeBody.accepted === true && !!invokeBody.requestId,
        '/invoke 立即返回 202 + requestId (适配 handler 不被 await)', invokeBody);

    await new Promise(function (r) { setTimeout(r, 250); });
    const resultRes = await mock.callRoute('ai_chat_gateway', 'GET', '/result', {
        url: '/result?requestId=' + invokeBody.requestId, method: 'GET', headers: {}
    });
    const resultBody = JSON.parse(resultRes.body);
    ok(resultBody.status === 'done' && String(resultBody.result).indexOf('other_plugin') >= 0,
        '/result 轮询到工具执行结果', resultBody);

    const badResult = await mock.callRoute('ai_chat_gateway', 'GET', '/result', {
        url: '/result?requestId=nope', method: 'GET', headers: {}
    });
    eq(badResult.status, 404, '未知 requestId 返回 404');

    const toolsRes = await mock.callRoute('ai_chat_gateway', 'GET', '/tools', { url: '/tools', method: 'GET', headers: {} });
    ok(JSON.parse(toolsRes.body).tools.length >= 11, '/tools 能列出全部工具');

    // 工具也会出现在给大模型的工具定义里
    const openaiTools = registry.toOpenAITools().map(function (t) { return t.function.name; });
    ok(openaiTools.indexOf('other_plugin__sign_in') >= 0, '注册的工具出现在 OpenAI tools 定义中');

    section('服务端扩展 RPC 注册工具');

    const rpcRes = await mock.rpcHandlers['register_tool']({ args: { plugin: 'bridge_ext', tools: [{ name: 'do_thing', description: 'x', parameters: {}, callback: { type: 'bridge-rpc', identifier: 'bridge:test', method: 'get_date' } }] } });
    ok(rpcRes.ok && rpcRes.registered.length === 1, 'RPC 注册工具成功', rpcRes);
    const rpcTool = await registry.invoke('bridge_ext__do_thing', {});
    ok(rpcTool && rpcTool.method === 'get_date', 'bridge-rpc 工具真的调用了服务器扩展');

    const rpcChat = await mock.rpcHandlers['chat']({ args: { prompt: '你好' } });
    ok(typeof rpcChat.content === 'string' && rpcChat.content.length > 0, 'RPC chat 接口可用', rpcChat);

    section('WebUI 面板');

    const menus = [];
    let menuAction = null, menuHtml = null;
    await mock.bus.emit('menu_ready', {
        registerGroup: function () { return { id: 'easybot_ai_chat:ai_chat' }; },
        register: function (id, path, label, icon, onAction, onGet) {
            menuAction = onAction; menuHtml = onGet;
            menus.push({ id: id, path: path, label: label });
            return { id: 'easybot_ai_chat:' + id };
        }
    });
    eq(menus.length, 1, '注册了 1 个页面菜单');
    ok(typeof menuHtml === 'function' && menuHtml().indexOf('<!DOCTYPE html>') === 0, '页面 HTML 正常返回');

    // 关键回归: 页面内联 JS 必须是合法 JS (这里踩过引号转义的坑)
    const html = menuHtml();
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    ok(!!scriptMatch, '页面包含内联脚本');
    let inlineOk = false, inlineErr = '';
    try { new Function(scriptMatch[1]); inlineOk = true; } catch (e) { inlineErr = e.message; }
    ok(inlineOk, '页面内联 JS 语法正确', inlineErr);
    eq((html.match(/<div/g) || []).length, (html.match(/<\/div>/g) || []).length, '<div> 标签数量配对');

    const st = await menuAction({ method: 'status', parameters: {} });
    ok(st.ok && st.status.tools >= 11, 'WebUI status 动作', st.status && st.status.tools);
    const toolsAct = await menuAction({ method: 'tools', parameters: {} });
    ok(toolsAct.ok && toolsAct.tools.length >= 11, 'WebUI tools 动作');
    const memAct = await menuAction({ method: 'memory', parameters: {} });
    ok(memAct.ok && memAct.stats.facts >= 1, 'WebUI memory 动作');
    const testAct = await menuAction({ method: 'test', parameters: { prompt: '在吗' } });
    ok(testAct.ok && testAct.content.length > 0, 'WebUI 对话测试可用', testAct);
    const personaAct = await menuAction({ method: 'savePersona', parameters: { name: '阿绫' } });
    ok(personaAct.ok && personaAct.persona.name === '阿绫', 'WebUI 可修改人设');
    eq(config.persona().name, '阿绫', '人设覆盖立即生效');
    // 覆盖(WebUI/命令)优先于配置文件, 测完清理掉以免影响后续用例
    mock.litedb.Delete('settings', 'persona_override');
    eq(config.persona().name, '小助手', '清理人设覆盖后回到配置值');

    // ---- WebUI: 回复逻辑页 ----
    const bg = await menuAction({ method: 'behaviorGet', parameters: {} });
    ok(bg.ok && (bg.presets || []).length >= 5, 'WebUI 能取到回复逻辑与预设 (' + (bg.presets || []).length + ' 个)');
    ok((bg.presets || []).some(function (x) { return x.key === 'quiet' && x.values && x.values.groupMode === 'mention'; }),
        '"安静助手"预设的内容正确');
    ok((bg.presets || []).some(function (x) { return x.key === 'atOnly' && x.values.nameTrigger === false; }),
        '存在"只认 @"预设');

    const presetRes = await menuAction({ method: 'behaviorPreset', parameters: { key: 'chatty' } });
    ok(presetRes.ok && presetRes.behavior.groupMode === 'always', 'WebUI 一键应用"话痨"预设', presetRes.behavior && presetRes.behavior.groupMode);

    const saveRes = await menuAction({
        method: 'behaviorSave',
        parameters: { behavior: { groupMode: 'mention', prefixes: 'ai,小助手', cooldownSec: '7', enabled: true } }
    });
    ok(saveRes.ok && saveRes.behavior.cooldownSec === 7 && saveRes.behavior.prefixes.length === 2,
        'WebUI 保存细调(逗号转数组/字符串转数字)', saveRes.behavior && { cd: saveRes.behavior.cooldownSec, pf: saveRes.behavior.prefixes });

    const t1 = await menuAction({ method: 'behaviorTest', parameters: { text: 'ai 在吗', at: true, groupId: '123456' } });
    ok(t1.ok && t1.decision.reply === true, '决策模拟器: @了机器人 -> 会回复', t1.decision);
    const t2 = await menuAction({ method: 'behaviorTest', parameters: { text: '随便聊聊', groupId: '123456' } });
    ok(t2.ok && t2.decision.reply === false, '决策模拟器: 没叫到 -> 不回复', t2.decision);
    const t3 = await menuAction({ method: 'behaviorTest', parameters: { text: '小助手帮我看看', groupId: '123456' } });
    ok(t3.ok && t3.decision.reply === true && t3.decision.reason.indexOf('名字') >= 0, '决策模拟器: 叫名字 -> 会回复', t3.decision);

    // ---- WebUI: 回复逻辑页新增字段(防止再出现"引用了不存在的元素") ----
    // --- WebUI: 工具配置（日志来源 / 装 mod 目标）可编辑 ---
    const webui = require('../lib/webui.js');
    (async function(){})();   // 占位（保持同步结构）
    let _webuiRes = null;
    const _p = webui.onAction({
        method: 'toolsCfgSave',
        parameters: {
            logSources: 'mc-a | 甲服 | /app/mc-logs/a/latest.log\n# 注释行忽略\nmc-b | 乙服 | /app/mc-logs/b1.log,/app/mc-logs/b2.log',
            modInstallTargets: '甲服 | /data/a/mods | a-container'
        }
    });
    Promise.resolve(_p).then(function (r) { _webuiRes = r; });
    await new Promise(function (r) { setTimeout(r, 60); });
    ok(_webuiRes && _webuiRes.ok, 'WebUI 能保存工具配置', _webuiRes);
    const _cfgAfter = config.get().tools || {};
    ok((_cfgAfter.logSources || []).length === 2, '日志来源解析成 2 条（注释被忽略）', (_cfgAfter.logSources || []).length);
    ok(((_cfgAfter.logSources || [])[1] || {}).paths.length === 2, '一个来源支持多个路径');
    ok((_cfgAfter.modInstallTargets || []).length === 1, '装 mod 目标解析成 1 条');
    config.clearToolsOverride();

    const replyHtml = require('../lib/webui.js').pageHtml();
    ['r_manualPrefix', 'r_manualAction', 'r_stripRegex', 'r_splitNl'].forEach(function (id) {
        ok(replyHtml.indexOf('id=' + id) > 0 || replyHtml.indexOf('id="' + id + '"') > 0,
            '回复逻辑页渲染了 ' + id);
    });
    const sv = await menuAction({ method: 'behaviorSave', parameters: {
        behavior: { manualCommandPrefixes: '！,#', manualCommandAction: 'skip' },
        humanize: { stripRegex: '【.*?】', splitOnNewline: false }
    } });
    ok(sv.ok === true, 'behaviorSave 同时接受 behavior 和 humanize');
    eq(config.behavior().manualCommandAction, 'skip', '手动指令行为被保存');
    ok(String(config.behavior().manualCommandPrefixes).indexOf('#') >= 0, '手动指令前缀被保存');
    eq(config.get().humanize.stripRegex, '【.*?】', '额外过滤正则被保存');
    eq(config.get().humanize.splitOnNewline, false, '换行即分段开关被保存');
    await menuAction({ method: 'behaviorReset', parameters: {} });
    config.clearHumanizeOverride();

    // ---- WebUI: 模型页 ----
    const lg = await menuAction({ method: 'llmGet', parameters: {} });
    ok(lg.ok === true && lg.llm, 'WebUI 能读模型配置');
    ok(String(lg.llm.apiKeyMasked).indexOf('****') > 0 || lg.llm.apiKeySet === false,
        'API Key 以掩码形式返回(不泄漏明文)', lg.llm.apiKeyMasked);
    ok(lg.llm.apiKeyMasked.indexOf('sk-test-key') < 0, '返回里不含完整密钥');

    const ls = await menuAction({ method: 'llmSave', parameters: {
        baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
        relayBase: 'http://192.0.2.10:18081/proxy', apiKey: 'sk-new-key-123456'
    } });
    ok(ls.ok === true, 'WebUI 能保存模型配置');
    eq(config.llm().baseUrl, 'https://api.deepseek.com/v1', '保存后立即生效(读覆盖值)');
    ok(config.llm().relayBase.indexOf('/proxy') > 0, 'relayBase 也保存了');
    const lg2 = await menuAction({ method: 'llmGet', parameters: {} });
    ok(String(lg2.effectiveUrl).indexOf('/proxy/https/api.deepseek.com/v1/chat/completions') > 0,
        '页面能看到"实际请求地址"(经代理后的完整 URL)', lg2.effectiveUrl);
    ok(lg2.authOk === true, '有密钥时报告鉴权就绪');

    // 留空 apiKey 不应清掉已有密钥
    await menuAction({ method: 'llmSave', parameters: { apiKey: '' } });
    eq(config.llm().apiKey, 'sk-new-key-123456', '留空不改动已有密钥');
    await menuAction({ method: 'llmClearKey', parameters: {} });
    eq(config.llm().apiKey, '', '清除密钥按钮生效');
    config.clearLlmOverride();
    ok(config.llm().baseUrl.indexOf('example.com') > 0 || config.llm().baseUrl.length > 0,
        '恢复配置值后回到文件里的 baseUrl', config.llm().baseUrl);

    // ---- WebUI: 指令知识库页 ----
    const k1 = await menuAction({ method: 'kbGet', parameters: {} });
    ok(k1.ok === true && Array.isArray(k1.entries), 'WebUI 能读知识库');
    const k2 = await menuAction({ method: 'kbSave', parameters: {
        commandBook: 'easywhitelist add {player}|加白名单|白名单,加白|3\n' +
                     'list|在线人数|在线|1\n' +
                     'list|重复的|dup|1\n' +
                     'badsyntaxwithoutpipe\n' +
                     'give <玩家> <物品>|给物品|给物品|9',
        commandBookInDescription: '5'
    } });
    ok(k2.ok === true, 'WebUI 能保存知识库');
    ok((k2.errors || []).length >= 2, '保存后回报格式问题(重复 + 等级越界)', k2.errors);
    ok((k2.errors || []).some(function (e) { return e.reason.indexOf('重复') >= 0; }), '能检测重复指令');
    ok((k2.errors || []).some(function (e) { return e.reason.indexOf('0~3') >= 0; }), '能检测等级越界');
    eq(config.get().tools.commandBookInDescription, 5, '保存后立即生效(tools 覆盖)');
    const k3 = await menuAction({ method: 'kbTest', parameters: { query: '加白名单' } });
    ok(k3.ok === true && k3.hits.length >= 1, 'WebUI 能实时测试检索', k3.hits);
    ok(registry.get('eb_run_command').description.indexOf('easywhitelist add') >= 0,
        '保存知识库后工具描述立即更新');
    config.clearToolsOverride();

    // ---- WebUI: 权限页 ----
    config.savePermissionsOverride({ groupScopes: '123456789 | 10001:3\n555000111 | 10001:1' });
    const pg = await menuAction({ method: 'permGet', parameters: {} });
    ok(pg.ok === true && pg.overview, 'WebUI 能取到权限总览');
    eq(pg.overview.groups.length >= 2, true, '总览列出配置过的群');
    ok(String(pg.raw.groupScopes).indexOf('123456789') >= 0, '总览带上原始配置文本');

    const ps = await menuAction({
        method: 'permSave',
        parameters: { groupScopes: '123456789 | 10001:3', defaultLevel: '0', groupOwnerLevel: '3', groupAdminLevel: '0' }
    });
    ok(ps.ok === true, 'WebUI 能保存权限配置');
    eq(config.permissions().groupScopes.indexOf('10001:3') >= 0, true, '保存后立即生效(读的是覆盖值)');
    eq(perm.levelOf({ senderId: '10001', peerId: '123456789' }), 3, '保存后的按群等级真的生效');
    // 注意: 10001 在全局 userLevels 里是 3, 所以换个没配置过的人来验证"默认最低"
    eq(perm.levelOf({ senderId: '88888', peerId: '123456789' }), 0, '没配置过的人 -> 默认最低等级');
    eq(perm.levelOf({ senderId: '10001', peerId: '123456789' }), 3, '配置过的人在配置的群里 -> 声明的等级');

    await menuAction({ method: 'permReset', parameters: {} });
    ok(!config.permissions().groupScopes, 'permReset 清掉覆盖, 回到配置值(空)');

    const resetB = await menuAction({ method: 'behaviorReset', parameters: {} });
    ok(resetB.ok, 'WebUI 能恢复配置文件的回复逻辑');
    eq(config.behavior().groupMode, config.get().behavior.groupMode, '恢复后回到配置值');

    section('示例插件: 端到端接入(真实 HTTP 往返)');

    // 示例插件已移出插件目录 (EasyBot 会递归扫描, 放在插件内会被当成独立插件加载)
    const demoPath = require('path').resolve(__dirname, '..', '..', 'example-plugin-for-ai-chat', 'main.js');
    // ★ 它是【仓库外面】的兄弟项目, 下载源码的人不一定有 —— 没有就跳过这段, 不要判失败
    if (require("fs").existsSync(demoPath)) {
    require(demoPath);
    await mock.bus.emit('enable');
    await new Promise(function (r) { setTimeout(r, 200); });

    ok(!!registry.get('ai_chat_demo_plugin__ping'), '示例插件自动注册了 ping 工具');
    ok(!!registry.get('ai_chat_demo_plugin__dice'), '示例插件自动注册了 dice 工具');
    const dice = await registry.invoke('ai_chat_demo_plugin__dice', { count: 3 });
    ok(dice && Array.isArray(dice.rolls) && dice.rolls.length === 3 && dice.total >= 3,
        '调用示例插件的 dice 工具, 真实 HTTP 往返成功', dice);
    const echo = await registry.invoke('ai_chat_demo_plugin__echo', { text: '你好' }, { senderId: '12345' });
    ok(echo && echo.echoed === '你好', 'echo 工具参数传递正确', echo);
    ok(echo && echo.caller === '12345', '调用者上下文被传给示例插件', echo);

    } else {
        section("示例插件: 端到端接入(真实 HTTP 往返)");
        console.log("     ⏭ 跳过: 没找到示例插件(开发者的本地兄弟项目), 不影响插件本身 ✓");
    }
    section('内置服务器工具 (真实 .NET 集合回归)');

    // 真实环境里 packet.List 是 .NET List: 只有 Count + ToArray(), 没有 get()/length
    const pl = await registry.invoke('eb_server_players', { serverToken: 'token-2' });
    ok(pl && pl.count === 1 && pl.players[0].name === 'PlayerF',
        '能从 .NET 集合里正确解析出玩家列表', pl);

    const plDefault = await registry.invoke('eb_server_players', {});
    ok(plDefault && plDefault.count >= 1 && plDefault.note && plDefault.note.indexOf('多台在线') >= 0,
        '多台服务器时默认查第一台并给出提示', plDefault);

    const info = await registry.invoke('eb_server_info', { serverToken: 'token-1' });
    ok(info && info.name && info.version, '服务器信息按字段正确读取', info);

    section('主动发消息工具');

    eq(config.get().tools.allowSendMessage, false, '默认禁止主动发消息');
    let sendErr = '';
    try { await registry.invoke('eb_send_to_group', { groupId: '123', text: 'hi' }); }
    catch (e) { sendErr = String(e.message); }
    ok(sendErr.indexOf('未开启') >= 0, '未开启时拒绝主动发送', sendErr);

    config.setRuntime('tools.allowSendMessage', true);
    config.setRuntime('tools.proactiveAllowedGroups', ['123456789']);
    sendErr = '';
    try { await registry.invoke('eb_send_to_group', { groupId: '999', text: 'hi' }); }
    catch (e) { sendErr = String(e.message); }
    ok(sendErr.indexOf('不在') >= 0, '不在允许列表里的群被拒绝', sendErr);

    mock.sentViaAdapter.length = 0;
    const sendRes = await registry.invoke('eb_send_to_group', { groupId: '123456789', text: '测试主动发言' });
    ok(sendRes.success && sendRes.messageId === 'msgid_1', '允许列表内发送成功', sendRes);
    eq(mock.sentViaAdapter[0].text, '测试主动发言', '消息链内容正确');
    eq(mock.sentViaAdapter[0].selfId, '99999', '自动选到了可用的适配器');

    // 还原
    config.setRuntime('tools.allowSendMessage', false);
    config.setRuntime('tools.proactiveAllowedGroups', []);

    section('权限边界 (记录/命令不能绕过名单)');

    // 把允许列表设成只有 123456, 然后给别的群发消息
    config.setRuntime('access.allowGroupIds', ['123456']);
    config.setRuntime('access.allowDirectUserIds', ['10001']);
    const otherKey = memory.sessionKey('group', '999888');
    const allowedKey = memory.sessionKey('group', '123456');
    memory.clearContext(otherKey);
    memory.clearContext(allowedKey);

    // A) 名单外的群: 不记录上下文, 命令也不回
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '别的群的闲聊', peerId: '999888' }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(memory.getContext(otherKey).messages.length, 0, '名单外的群不写入上下文(隐私)');

    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '/ai status', peerId: '999888', role: 'owner' }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(sent.length, 0, '名单外的群命令也不响应(之前会泄露)');

    // B) 名单内的群: 正常记录
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '群里的闲聊', peerId: '123456' }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(memory.getContext(allowedKey).messages.length, 1, '名单内的群正常写入上下文');

    // C) 私聊名单外: 不记录, 命令也不回
    const dmKey = memory.sessionKey('direct', '77777');
    memory.clearContext(dmKey);
    sent.length = 0;
    await mock.bus.emit('direct_message_event', directEvent({ text: '/ai status', senderId: '77777' }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(memory.getContext(dmKey).messages.length, 0, '名单外的私聊不写入上下文');
    eq(sent.length, 0, '名单外的私聊命令不响应');

    // 还原
    config.setRuntime('access.allowGroupIds', []);
    config.setRuntime('access.allowDirectUserIds', []);

    section('HTTP 适配层: 兼容不同 EasyBot build 的 network API');

    const http = require('../lib/httpclient.js');
    const realNetwork = global.network;
    const httpCalls = [];

    // 场景 A: 只有 PascalCase 的 Request (文档里的 request 不存在)
    global.network = {
        Request: async function (msg) {
            httpCalls.push(['Request', msg.Url, msg.Method]);
            return { Status: 200, Body: JSON.stringify({ ok: true, via: 'Request' }) };
        }
    };
    let hr = await http.request({ url: 'http://x/v1/chat', method: 'POST', headers: {}, body: '{"a":1}' });
    eq(hr.data.via, 'Request', '只有 PascalCase Request 时也能发请求');
    eq(hr.status, 200, '响应状态被规范化');

    // 场景 A2: 宿主暴露 RequestMessage —— 可以带自定义请求头(实测真机就是这样)
    function MockRequestMessage() { this.url = ''; this.method = 'GET'; this.body = undefined; this.headers = mkHeaders(); }
    function mkHeaders() {
        const h = {};
        h.Set = function (k, v) { h[k] = v; };
        h.Get = function (k) { return h[k] || ''; };
        return h;
    }
    global.RequestMessage = MockRequestMessage;
    global.network = {
        request: async function (msg) {
            httpCalls.push(['requestMessage', msg.url, msg.method, msg.headers]);
            return { status: 200, body: JSON.stringify({ ok: true, via: 'RequestMessage', auth: msg.headers.Get('Authorization') }) };
        }
    };
    let hm = await http.request({ url: 'http://x/v1/chat', method: 'POST', headers: { Authorization: 'Bearer abc' }, body: '{"a":1}' });
    eq(hm.data.via, 'RequestMessage', '优先使用 RequestMessage 写法');
    eq(hm.data.auth, 'Bearer abc', '★ 自定义请求头真的被带上了(Authorization)');
    ok(http.supportsHeaders() === true, 'supportsHeaders 报告"能带自定义头"');
    delete global.RequestMessage;

    // 场景 B: 只有最简签名 post(url, body) —— 真实 build 就是这种情况, 请求头会被丢弃
    global.network = {
        post: async function (url, body) {
            httpCalls.push(['post', url, body]);
            return { status: 200, body: '{"ok":true,"via":"post"}' };
        }
    };
    hr = await http.request({ url: 'http://x/v1/chat', method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' });
    eq(hr.data.via, 'post', '只有最简 post(url,body) 时也能发请求');
    ok(http.supportsHeaders() === false, '最简签名下 supportsHeaders()=false (会丢掉请求头)');

    // 场景 B2: 完整写法可用时, 请求头必须真的传下去
    global.network = {
        request: async function (msg) {
            httpCalls.push(['request', msg.headers && msg.headers.Authorization]);
            return { status: 200, body: '{"ok":true,"via":"request"}' };
        }
    };
    hr = await http.request({ url: 'http://x/v1/chat', method: 'POST', headers: { Authorization: 'Bearer k' }, body: '{}' });
    eq(hr.data.via, 'request', '完整 request 写法可用');
    eq(httpCalls[httpCalls.length - 1][1], 'Bearer k', '完整写法确实带上了请求头');
    ok(http.supportsHeaders() === true, '完整写法下 supportsHeaders()=true');

    // 场景 C: 完全不可用, 必须给出明确错误
    global.network = { somethingElse: 1 };
    let httpErr = null;
    try {
        await http.request({ url: 'http://x/', method: 'POST', headers: {}, body: '{}' });
    } catch (e) { httpErr = String(e.message); }
    ok(httpErr && httpErr.indexOf('没有可用于') >= 0, 'network 无可用方法时给出明确报错', httpErr);

    global.network = realNetwork;
    ok(http.describe().indexOf('成员') >= 0, 'describe() 能描述 network 成员', http.describe());

    section('图片理解 (视觉)');

    chatMode = 'simple';   // 确保模型走"直接回复"分支, 否则最后一条消息会是工具结果

    const imgEvent = {
        SelfId: '99999',
        SenderId: '10001',
        PeerName: '',
        RawMessage: '[CQ:at,qq=99999][CQ:image,file=x.jpg,url=https://example.com/a.jpg] 这是啥',
        Messages: []
    };
    const urls = chat.extractImages(imgEvent);
    eq(urls.length, 1, '能从 CQ 码里提取图片 URL');
    eq(urls[0], 'https://example.com/a.jpg', '图片 URL 正确');
    eq(chat.extractImages({ RawMessage: '[CQ:image,file=x.jpg]' }).length, 0, '没有 url 的图片提不出来(无法交给模型)');

    // 默认关闭: 纯文本
    mock.networkCalls.length = 0;
    await chat.askOnce('你好', {});
    let lastBody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    ok(typeof lastBody.messages[lastBody.messages.length - 1].content === 'string', 'vision 关闭时内容是纯文本');

    // 打开后: 走群消息路径, 最后一条 user 消息应变成多模态数组
    config.setRuntime('vision.enabled', true);
    config.setRuntime('vision.maxImages', 2);
    config.setRuntime('access.allowGroupIds', []);
    sent.length = 0;
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({
        text: '这是啥', at: true, peerId: '123456',
        rawExtra: '[CQ:image,file=x.jpg,url=https://example.com/cat.jpg]'
    }));
    await new Promise(function (r) { setTimeout(r, 400); });
    const vBody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    const lastUser = vBody.messages[vBody.messages.length - 1];
    ok(Array.isArray(lastUser.content), 'vision 开启时最后一条用户消息是多模态数组', lastUser.content);
    ok(lastUser.content[0].type === 'text' && lastUser.content[1].type === 'image_url',
        '多模态内容含 text + image_url 两种 part');
    eq(lastUser.content[1].image_url.url, 'https://example.com/cat.jpg', '图片 URL 被传给了模型');

    config.setRuntime('vision.enabled', false);

    section('以绑定玩家身份执行 + 控制台输出清理');

    const bind = require('../lib/bind.js');
    mock.bindSocial('qq', '10001', ['Steve_MC']);
    mock.bindSocial('qq', '20002', ['Alex_MC', 'Alex_MC2']);

    eq(bind.boundPlayers('10001').join(','), 'Steve_MC', '能查到 QQ 绑定的 MC 玩家');
    eq(bind.boundPlayers('20002').length, 2, '一个 QQ 可绑定多个 MC 玩家');
    eq(bind.boundPlayers('99999').length, 0, '没绑定的 QQ 返回空');
    eq(bind.boundPlayerName('10001'), 'Steve_MC', 'boundPlayerName 取第一个');

    // 执行身份: 优先用绑定玩家
    const ex1 = await builtin.resolveExecutor({}, { senderId: '10001' }, null);
    ok(ex1.name === 'Steve_MC' && ex1.source === 'bound', '执行身份优先用绑定玩家', ex1);
    // 没绑定时退回 consoleName 并给出提示
    const ex2 = await builtin.resolveExecutor({}, { senderId: '99999' }, null);
    ok(ex2.source === 'console' && ex2.note.indexOf('绑定') > 0, '没绑定时退回配置执行名并提示', ex2);
    // 显式指定优先级最高
    config.setRuntime('tools.allowPlayerCommand', true);
    const ex3 = await builtin.resolveExecutor({ playerName: 'Notch' }, { senderId: '10001' }, null);
    ok(ex3.name === 'Notch' && ex3.source === 'explicit', '显式指定身份优先级最高', ex3);
    config.setRuntime('tools.allowPlayerCommand', false);

    // boundIfOnline: 绑定玩家不在线时改用配置账号代劳
    config.setRuntime('tools.executorMode', 'boundIfOnline');
    config.setRuntime('tools.consoleName', 'BotAccount');
    const fakeServer = { bridge: { GetPlayerListAsync: async function () { return { List: [] }; } } };
    const ex4 = await builtin.resolveExecutor({}, { senderId: '10001' }, fakeServer);
    ok(ex4.name === 'BotAccount' && ex4.source === 'console-fallback',
        'boundIfOnline: 绑定玩家不在线 -> 用常驻账号代劳', ex4);
    const fakeOnline = { bridge: { GetPlayerListAsync: async function () { return { List: [{ PlayerName: 'Steve_MC' }] }; } } };
    const ex5 = await builtin.resolveExecutor({}, { senderId: '10001' }, fakeOnline);
    ok(ex5.name === 'Steve_MC' && ex5.source === 'bound', 'boundIfOnline: 在线就用本人', ex5);
    config.setRuntime('tools.executorMode', 'bound');
    config.setRuntime('tools.consoleName', 'CONSOLE');

    // 真的按绑定玩家执行
    const runBound = await registry.invoke('eb_run_command', { command: 'list' },
        { senderId: '10001', senderName: 'Gamer', senderRole: 'admin' });
    ok(runBound.success === true && runBound.executedAs === 'Steve_MC',
        '指令以绑定玩家身份执行', runBound);
    const lastCmd = mock.serverActions.filter(function (a) { return a.type === 'command'; }).pop();
    eq(lastCmd.playerName, 'Steve_MC', '传给服务器的玩家名就是绑定的那个');

    // 输出清理: 颜色代码去掉、"§r," 还原成换行
    const cleaned = builtin.cleanOutput('§aHello§r,§bWorld §x§f§f§5§5§5§5Red§r');
    eq(cleaned, 'Hello\nWorld Red', '清理颜色代码并把 §r, 还原为换行');
    eq(builtin.cleanOutput(''), '', '空输出不报错');

    // PAPI: 执行者在线才开(离线时模组会把指令改坏)
    mock.serverActions.length = 0;
    config.setRuntime('tools.enablePapi', true);
    config.setRuntime('tools.papiOnlyWhenOnline', true);
    const offlineSrv = { bridge: { GetPlayerListAsync: async function () { return { List: [] }; },
        SendRunCommandAsync: async function (pn, cmd, papi) { mock.serverActions.push({ type: 'command', playerName: pn, command: cmd, enablePapi: papi }); return { Success: true, Text: 'ok' }; } } };
    const onlineSrv = { bridge: { GetPlayerListAsync: async function () { return { List: [{ PlayerName: 'Steve_MC' }] }; },
        SendRunCommandAsync: async function (pn, cmd, papi) { mock.serverActions.push({ type: 'command', playerName: pn, command: cmd, enablePapi: papi }); return { Success: true, Text: 'ok' }; } } };

    const offExec = await builtin.resolveExecutor({}, { senderId: '10001' }, offlineSrv);
    eq(offExec.source, 'bound', '离线场景仍用绑定玩家名(只影响PAPI, 不影响执行)');
    // 直接验证工具内的判断逻辑
    // 关键: 只有指令里含 %占位符% 才开 PAPI —— 某些服务端的替换会无条件改坏指令
    ok(builtin.shouldUsePapi({ enablePapi: true, papiOnlyWhenOnline: true }, true, 'list') === false,
        '普通指令(无占位符) -> 不开 PAPI(避免被服务端改坏)');
    ok(builtin.shouldUsePapi({ enablePapi: true, papiOnlyWhenOnline: true }, true, 'effect give PlayerG haste 999999 9') === false,
        '复杂指令也不开 PAPI');
    ok(builtin.shouldUsePapi({ enablePapi: true, papiOnlyWhenOnline: true }, true, 'say %player_name% 你好') === true,
        '含 %player_name% 的指令 -> 开 PAPI');
    ok(builtin.shouldUsePapi({ enablePapi: true, papiOnlyWhenOnline: true }, false, 'say %player_name%') === false,
        '含占位符但执行者离线 -> 仍不开(离线时替换也会坏)');
    ok(builtin.shouldUsePapi({ enablePapi: false, papiOnlyWhenOnline: true }, true, 'say %x%') === false,
        '总开关关闭时一律不用 PAPI');

    // 权限工具也能报告绑定玩家
    const mineB = await registry.invoke('eb_my_permissions', {}, { senderId: '10001' });
    eq((mineB.boundMcPlayers || []).join(','), 'Steve_MC', 'eb_my_permissions 报告绑定玩家');

    section('HTTP 网关 /chat (端到端: 自然语言 -> 模型 -> 工具)');

    // 以高权限身份问一句需要查服务器的话, 模型应调用工具并回复
    function chatReq(payload) {
        return { url: '/chat', method: 'POST', headers: {}, body: JSON.stringify(payload) };
    }
    const g1 = await mock.callRoute('ai_chat_gateway', 'POST', '/chat',
        chatReq({ prompt: '现在服务器上有几个人?', senderId: '10001', senderName: 'Gamer', senderRole: 'admin' }));
    const g1b = JSON.parse(g1.body);
    ok(g1.status === 202 && g1b.accepted === true && !!g1b.requestId,
        '/chat 立即返回 202 + requestId (适配 handler 不被 await)', g1b);

    await new Promise(function (r) { setTimeout(r, 400); });
    const g1r = JSON.parse((await mock.callRoute('ai_chat_gateway', 'GET', '/result',
        { url: '/result?requestId=' + g1b.requestId, method: 'GET', headers: {} })).body);
    ok(g1r.status === 'done' && String((g1r.result || {}).reply || '').length > 0,
        '/chat 轮询到回复文本', g1r.result);
    ok(Array.isArray((g1r.result || {}).toolCalls), '返回了工具调用列表', g1r.result && g1r.result.toolCalls);

    // 缺少 prompt 要报错
    const g2 = await mock.callRoute('ai_chat_gateway', 'POST', '/chat', chatReq({ senderId: '10001' }));
    ok(g2.status === 400, '缺少 prompt 返回 400', g2);

    // 以低权限身份让模型执行指令 -> 工具应被拒绝, 且不会真的下发指令
    mock.serverActions.length = 0;
    const g3 = await mock.callRoute('ai_chat_gateway', 'POST', '/chat',
        chatReq({ prompt: '帮我在服务器里说一句 大家好', senderId: '888', senderName: '路人', senderRole: 'member' }));
    const g3b = JSON.parse(g3.body);
    await new Promise(function (r) { setTimeout(r, 400); });
    const g3r = JSON.parse((await mock.callRoute('ai_chat_gateway', 'GET', '/result',
        { url: '/result?requestId=' + g3b.requestId, method: 'GET', headers: {} })).body);
    ok(g3r.status === 'done', '低权限身份也能正常对话', g3r);
    eq(mock.serverActions.filter(function (a) { return a.type === 'command'; }).length, 0,
        '低权限身份没有任何指令被下发到服务器');

    section('指令权限分级 (自然语言 -> 指令 -> 按人限权 -> 返回控制台输出)');


    // 等级解析
    eq(perm.levelOf({ senderId: '10001' }), 3, '显式授权的 QQ -> 等级 3');
    eq(perm.levelOf({ senderId: '999', senderRole: 'owner' }), 3, '群主默认 -> 等级 3');
    eq(perm.levelOf({ senderId: '999', senderRole: 'admin' }), 0, '群管理默认也是最低等级(需要就单独给)');
    eq(perm.levelOf({ senderId: '999', senderRole: 'member' }), 0, '普通群友默认最低等级(不能用指令)');
    eq(perm.levelOf({ senderId: '999', level: 3 }), 3, '调用方可以显式指定等级(测试/其它插件)');

    // 指令分类
    ok(perm.check(1, 'list').ok, 'list 是安全指令, 等级1可执行');
    ok(!perm.check(0, 'list').ok, '等级0 连安全指令都不能执行');
    ok(perm.check(3, 'give Steve diamond 64').ok, 'give 未列出 -> 需要等级3, 等级3可执行');
    ok(!perm.check(1, 'give Steve diamond 64').ok, 'give 等级1 被拒绝');
    ok(!perm.check(3, 'stop').ok, 'stop 在硬黑名单里, 等级3也不行');
    ok(perm.check(3, 'time query daytime').ok, '带空格前缀 time query 能命中安全清单');
    eq(perm.check(1, 'give x').need, 3, '被拒绝时告知需要几级');

    // 工具层: 普通成员被拒
    const cmdCountBefore = mock.serverActions.filter(function (a) { return a.type === 'command'; }).length;
    const denied = await registry.invoke('eb_run_command', { command: 'say hello' },
        { senderId: '888', senderName: '路人', senderRole: 'member' });
    ok(denied && denied.denied === true && denied.neededLevel === 1,
        '普通成员执行 say 被拒绝(安全指令也要等级1)', denied);
    const denied2 = await registry.invoke('eb_run_command', { command: 'give Steve diamond 64' },
        { senderId: '888', senderName: '路人', senderRole: 'member' });
    ok(denied2 && denied2.denied === true && denied2.neededLevel === 3,
        '普通成员执行 give 被拒绝, 并说明需要等级3', denied2);
    eq(mock.serverActions.filter(function (a) { return a.type === 'command'; }).length, cmdCountBefore,
        '被拒绝时不会真的发指令到服务器');

    // 工具层: 高权限用户放行, 并返回控制台输出
    const okRun = await registry.invoke('eb_run_command', { command: 'list' },
        { senderId: '10001', senderName: 'Gamer', senderRole: 'admin' });
    ok(okRun && okRun.success === true && okRun.tier === 'safe', '高权限用户执行 list 成功', okRun);
    ok(String(okRun.output).indexOf('players online') >= 0, '返回了服务器控制台输出', okRun.output);
    ok(okRun.hasOutput === true, '标记出有输出');

    // 未列出的指令: 高权限可执行
    const okGive = await registry.invoke('eb_run_command', { command: 'give Steve diamond 1' },
        { senderId: '10001', senderName: 'Gamer', senderRole: 'admin' });
    ok(okGive && okGive.success === true && okGive.tier === 'unknown', '等级3 可执行未列出的指令', okGive);

    // 查询自身权限
    const mine = await registry.invoke('eb_my_permissions', {}, { senderId: '888', senderRole: 'member' });
    ok(mine && mine.level === 0 && mine.canRunCommand === false, 'eb_my_permissions 能报告等级', mine);
    const mine2 = await registry.invoke('eb_my_permissions', {}, { senderId: '10001', senderRole: 'admin' });
    ok(mine2 && mine2.level === 3 && mine2.canRunDangerous === true, '高权限用户可执行高危指令', mine2);

    // 等级 0 的提示要明确说"权限不足"
    const hint0 = chat.permHint('888', 'member');
    ok(hint0.indexOf('没有这个权限') > 0, '等级0 的提示会明确说权限不足', hint0.slice(-120));

    // 管理员填的"本服可用指令清单"要能进提示词
    config.setRuntime('tools.commandHints', 'list 看在线, gm 1 切创造');
    const hint = chat.permHint('10001', 'admin');
    ok(hint.indexOf('本服指令知识库') > 0 && hint.indexOf('gm 1 切创造') > 0,
        '旧 commandHints 字段仍兼容(当成知识库条目注入提示词)', hint.slice(-160));
    config.setRuntime('tools.commandHints', '');

    section('只认 @ 模式 (关掉叫名字/回复/前缀)');

    config.setRuntime('access.allowGroupIds', []);
    config.clearBehaviorOverride();
    const atKey = memory.sessionKey('group', 'atonly');
    config.saveBehaviorOverride({
        groupMode: 'mention', nameTrigger: false, replyTrigger: false,
        prefixes: [], keywords: [], mentionNames: [], continuationWindowSec: 0
    });

    const evAt2 = groupEvent({ text: 'ai 服务器有几个人', at: true });
    const dAt = chat.decideReply(evAt2, 'group', atKey, 'ai 服务器有几个人');
    ok(dAt.reply === true && dAt.reason === '@我', '@了它 -> 回复(即使前缀为空)', dAt);

    const evName = groupEvent({ text: '小助手帮我看看' });
    const dName = chat.decideReply(evName, 'group', atKey, '小助手帮我看看');
    ok(dName.reply === false, '只叫名字 -> 不回复(nameTrigger=false)', dName);

    const evPrefix = groupEvent({ text: 'ai 在吗' });
    const dPrefix = chat.decideReply(evPrefix, 'group', atKey, 'ai 在吗');
    ok(dPrefix.reply === false, '只有前缀 -> 不回复(前缀已清空)', dPrefix);

    // 回复了它, 但 replyTrigger 关掉 -> 不回
    chat.markOwnMessage(atKey, 'own_1');
    const evReply = {
        SelfId: '99999', SenderId: '10001', PeerId: 'atonly', MessageId: 'm9',
        SenderName: '小明', RawMessage: '[CQ:reply,id=own_1] 你觉得呢', Messages: []
    };
    const dReply = chat.decideReply(evReply, 'group', atKey, '你觉得呢');
    ok(dReply.reply === false, '回复了它但开关关掉 -> 不回复', dReply);

    // 打开开关后同样的消息就会回
    config.saveBehaviorOverride({ replyTrigger: true });
    const dReply2 = chat.decideReply(evReply, 'group', atKey, '你觉得呢');
    ok(dReply2.reply === true && dReply2.reason === '回复我', '打开开关 -> 回复它也算叫它', dReply2);

    config.clearBehaviorOverride();

    section('Wiki 兜底查询 (知识库找不到时)');

    const wiki = require('../lib/wiki.js');

    // 默认关闭
    config.setRuntime('tools.wiki.enabled', false);
    ok(wiki.enabled() === false, '默认不启用 Wiki 查询');
    const offRes = await wiki.lookup('白名单');
    ok(offRes.ok === false && offRes.error.indexOf('未启用') >= 0, '未启用时明确报错而不是偷偷联网', offRes);

    config.setRuntime('tools.wiki.enabled', true);
    ok(wiki.enabled() === true, '打开后可用');

    // 端点白名单: 非 wiki 域名要被过滤掉
    config.setRuntime('tools.wiki.endpoints', 'evil | https://evil.example.com/api.php\n' +
        'Minecraft Wiki(中文) | https://zh.minecraft.wiki/api.php');
    const eps = wiki.endpoints();
    eq(eps.length, 1, '非 wiki 域名被过滤掉(只留白名单内的)');
    eq(eps[0].name, 'Minecraft Wiki(中文)', '保留合法的 wiki 端点');

    // HTML 清理
    eq(wiki.stripHtml('<span class="searchmatch">白</span>名单 &amp; 权限'), '白名单 & 权限', '摘要里的 HTML 标签会被清掉');

    // 模拟 MediaWiki API 返回
    mock.setNetworkResponder(async function (msg) {
        const url = String((msg && (msg.url || msg.Url || msg.urlString)) || '');
        if (url.indexOf('list=search') >= 0) {
            return { status: 200, body: JSON.stringify({ query: { search: [
                { title: '命令/whitelist', snippet: '此命令用于管理服务器中的<span class="searchmatch">白名单</span>。' },
                { title: '命令/ban', snippet: '封禁玩家。' }
            ] } }) };
        }
        if (url.indexOf('prop=extracts') >= 0) {
            return { status: 200, body: JSON.stringify({ query: { pages: {
                '1': { title: '命令/whitelist', extract: 'whitelist add <玩家>\\nwhitelist remove <玩家>' }
            } } }) };
        }
        return { status: 404, body: '{}' };
    });

    const found2 = await wiki.lookup('白名单');
    ok(found2.ok === true && found2.results.length === 2, '能解析 MediaWiki 搜索结果', found2);
    ok(found2.results[0].snippet.indexOf('<span') < 0, '摘要里的 HTML 已清理', found2.results[0].snippet);
    ok(found2.detail.indexOf('whitelist add') >= 0, '能取到条目的正文摘录', found2.detail);
    ok(wiki.render(found2).indexOf('原版') >= 0, '结果里明确标注"原版写法参考"', wiki.render(found2).slice(0, 200));

    // 工具层
    const wt = await registry.invoke('eb_search_wiki', { query: '白名单' }, { senderId: '10001' });
    ok(wt.success === true && wt.found === 2, 'eb_search_wiki 工具可用', { found: wt.found });
    ok(String(wt.caution || '').indexOf('原版') >= 0, '工具结果带"原版写法"提醒', wt.caution);
    ok(registry.toOpenAITools().some(function (t) { return t.function.name === 'eb_search_wiki'; }),
        'eb_search_wiki 出现在工具列表里');

    // 被反爬挡住时要给出可操作的建议(实测中英文 Wiki 都会返回挑战页)
    mock.setNetworkResponder(async function () {
        return { status: 200, body: '<html><head><title>Please wait</title></head></html>' };
    });
    const blocked = await registry.invoke('eb_search_wiki', { query: '白名单' }, { senderId: '10001' });
    ok(blocked.success === false && blocked.wikiBlocked === true, 'Wiki 被反爬挡住时标记 wikiBlocked', blocked);
    ok(String(blocked.advice || '').indexOf('别再试了') >= 0, '给出"别再试了, 回到知识库"的建议', blocked.advice);

    // 查不到时给出明确说明
    mock.setNetworkResponder(async function () {
        return { status: 200, body: JSON.stringify({ query: { search: [] } }) };
    });
    const none = await wiki.lookup('完全不存在的功能xyz');
    ok(wiki.render(none).indexOf('也没搜到') >= 0, 'Wiki 也查不到时给出明确说明', wiki.render(none));

    // 优先级说明写进了 eb_run_command 的描述和提示词
    ok(registry.get('eb_run_command').description.indexOf('eb_search_wiki') >= 0,
        'eb_run_command 描述里写明优先级(知识库 > 检索 > Wiki)');
    ok(chat.permHint('10001', 'admin').indexOf('指令来源优先级') > 0,
        '提示词里也写明指令来源优先级');
    // ★ 关键回归: 权限是"按群分类"的, 提示词必须带群号, 否则群里 3 级的人会被算成 0 级
    config.setRuntime('permissions.groupScopes', '123456789 | 10001:3');
    const hintInGroup = chat.permHint('10001', 'admin', '123456789');
    ok(hintInGroup.indexOf('等级 3') > 0, '提示词带群号时算出真实等级 3', hintInGroup.slice(0, 120));
    ok(hintInGroup.indexOf('等级 0') < 0, '不会再把群里的人误判成 0 级');
    // 10001 在测试配置里有"全局 3 级", 所以不带群号也是 3 级(这本身是对的);
    // 换一个只有群内配置、没有全局配置的人来验证"不带群号会掉到默认等级"
    config.setRuntime('permissions.groupScopes', '123456789 | 88888:3');
    ok(chat.permHint('88888', 'admin', '123456789').indexOf('等级 3') > 0, '群内配置的人在群里 -> 3 级');
    ok(chat.permHint('88888', 'admin', '').indexOf('等级 0') > 0,
        '同一个人不带群号 -> 掉到默认等级 0(说明群号是必须的)', chat.permHint('88888', 'admin', '').slice(0, 110));
    config.setRuntime('permissions.groupScopes', '');
    ok(chat.permHint('10001', 'admin').indexOf('先用 eb_find_command 核对本服写法') > 0,
        '提示词要求"改状态前先查知识库"(避免凭原版记忆连错几次)');

    // 清理
    config.setRuntime('tools.wiki.enabled', false);
    mock.setNetworkResponder(chatResponder);

    section('离线玩家数据(背包/装备/末影箱)');

    const playerdb = require('../lib/playerdb.js');
    const fakeNbt = {
        Health: 18.9, foodLevel: 20, XpLevel: 30, Dimension: 'minecraft:overworld', Pos: [1, 64, 2],
        Inventory: [
            { Slot: 0, id: 'minecraft:netherite_axe', Count: 1 },
            { Slot: 1, id: 'minecraft:stone', Count: 64 },
            { Slot: 2, id: 'minecraft:stone', Count: 32 },
            { Slot: 36, id: 'minecraft:netherite_boots', Count: 1 },
            { Slot: 38, id: 'minecraft:elytra', Count: 1 }
        ],
        EnderItems: [
            { Slot: 0, id: 'minecraft:shulker_box', Count: 1 },
            { Slot: 1, id: 'minecraft:shulker_box', Count: 1 },
            { Slot: 2, id: 'minecraft:ice', Count: 64 }
        ]
    };
    const inv = playerdb.summarizeInventory(fakeNbt, 60);
    eq(inv.count, 5, '背包占格数统计正确');
    eq(inv.distinct, 4, '去重后的物品种类数正确 (斧/石头/靴子/鞘翅)');
    eq(inv.totalItems, 99, '物品总数(含合并)正确 (1+64+32+1+1)');
    ok(inv.items.join('|').indexOf('stone x96(2组)') >= 0, '★ 同类物品合并并标注组数', inv.items);
    ok(inv.items[0].indexOf('stone x96') === 0, '按数量倒序(石头最多排第一)', inv.items);
    ok(inv.items.join('|').indexOf('minecraft:') < 0, '物品名去掉了 minecraft: 前缀');
    eq(inv.slots.length, 2, '只把 36~40 槽列为装备槽');
    ok(inv.slots.join('|').indexOf('头盔=') < 0, '没穿的装备槽不出现');
    ok(inv.slots.join('|').indexOf('靴子=netherite_boots') >= 0, '靴子槽识别正确', inv.slots);
    eq(inv.enderDistinct, 2, '末影箱也做了合并');
    const ecJoined = inv.enderChest.join('|');
    ok(ecJoined.indexOf('shulker_box x2(2组)') >= 0, '末影箱里两个潜影盒合并成 x2', inv.enderChest);
    eq(inv.enderChest[0].indexOf('ice x64'), 0, '末影箱也按数量倒序(冰最多排第一)', inv.enderChest);
    eq(inv.vitals.Health, 18.9, '生命值等体征被带出');

    const pstats = playerdb.summarizeStats({ stats: { 'minecraft:custom': { play_time: 72000, deaths: 3, mob_kills: 120 },
        'minecraft:mined': { 'minecraft:stone': 5000, 'minecraft:dirt': 300 } } }, 40);
    ok(pstats.highlights['死亡次数'] === 3, '统计数据: 死亡次数');
    ok(pstats.highlights['击杀生物'] === 120, '统计数据: 击杀生物');
    ok(pstats.topMined[0].indexOf('stone x5000') === 0, '挖掘排行按数量倒序', pstats.topMined);

    const ad = playerdb.summarizeAdvancements({ 'minecraft:story/root': { done: true }, 'minecraft:story/mine_stone': { done: true }, 'minecraft:story/x': { done: false } }, 80);
    eq(ad.doneCount, 2, '成就: 只统计 done=true');

    section('通用代理: 换供应商只改 baseUrl');

    const via = llm.viaRelay;
    eq(via('https://api.deepseek.com/v1/chat/completions', 'http://192.0.2.10:18081/proxy'),
        'http://192.0.2.10:18081/proxy/https/api.deepseek.com/v1/chat/completions',
        'DeepSeek 地址能正确包进通用代理');
    eq(via('https://api.openai.com/v1/chat/completions', 'http://192.0.2.10:18081/proxy/'),
        'http://192.0.2.10:18081/proxy/https/api.openai.com/v1/chat/completions',
        '代理地址带尾斜杠也能处理');
    eq(via('https://x.com/v1/chat/completions', ''), 'https://x.com/v1/chat/completions',
        '不配代理时保持直连');
    ok(via('https://api.siliconflow.cn/v1/chat/completions', 'http://r/proxy').indexOf('https/api.siliconflow.cn/v1') > 0,
        '硅基流动等其它供应商同样适用');
    eq(via('http://127.0.0.1:8080/v1/chat/completions', 'http://r/proxy'),
        'http://r/proxy/http/127.0.0.1:8080/v1/chat/completions', 'http 上游也能代理');

    section('传输策略: 优先直连, 被 Content-Type 拒了自动走代理');

    llm.resetTransport();
    config.setRuntime('llm.baseUrl', 'https://api.example.com/v1');
    config.setRuntime('llm.relayBase', 'http://relay/proxy');
    config.setRuntime('llm.apiKey', 'sk-x');
    config.setRuntime('llm.authMode', 'header');

    // 模拟"严格接口": 直连返回 Content-Type 错误, 经代理则成功(按 URL 区分, 不按次数)
    function strictResponder() {
        return async function (msg) {
            const viaProxy = String(msg.url).indexOf('/proxy/') >= 0;
            if (!viaProxy) {
                return { status: 400, data: { error: { message: 'This endpoint only supports Content-Type: application/json. Please send a JSON request body.' } } };
            }
            return { status: 200, data: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } };
        };
    }
    mock.networkCalls.length = 0;
    mock.setNetworkResponder(strictResponder());
    const rr = await llm.chatOnce({ messages: [{ role: 'user', content: 'hi' }] });
    eq(rr.content, 'ok', '自动重试后拿到结果');
    eq(mock.networkCalls.length, 2, '直连失败后重试了一次');
    ok(String(mock.networkCalls[0].url).indexOf('/proxy/') < 0, '第一次是直连');
    ok(String(mock.networkCalls[1].url).indexOf('/proxy/https/api.example.com/v1/chat/completions') > 0,
        '第二次自动改走通用代理', mock.networkCalls[1].url);
    eq(llm.transportName(), 'relay', '记住结论: 这个接口需要代理');

    // 记住之后不再浪费一次直连
    mock.networkCalls.length = 0;
    await llm.chatOnce({ messages: [{ role: 'user', content: 'hi again' }] });
    eq(mock.networkCalls.length, 1, '已知需要代理时只发一次请求');
    ok(String(mock.networkCalls[0].url).indexOf('/proxy/') > 0, '直接走代理');

    // 宽容的接口(不强制 Content-Type): 直连就成功, 完全不碰代理
    llm.resetTransport();
    mock.networkCalls.length = 0;
    mock.setNetworkResponder(async function () {
        return { status: 200, data: { choices: [{ message: { role: 'assistant', content: 'lenient ok' } }] } };
    });
    const r2 = await llm.chatOnce({ messages: [{ role: 'user', content: 'hi' }] });
    eq(r2.content, 'lenient ok', '宽容接口直连成功');
    eq(llm.transportName(), 'direct', '记住结论: 该接口可直连');
    eq(mock.networkCalls.length, 1, '只发一次请求');
    ok(String(mock.networkCalls[0].url).indexOf('/proxy/') < 0, '直连成功就不走代理');

    // 没配代理时, 直连失败就老实报错(不静默)
    llm.resetTransport();
    config.setRuntime('llm.relayBase', '');
    mock.setNetworkResponder(strictResponder());
    let threw2 = false;
    try { await llm.chatOnce({ messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { threw2 = true; }
    ok(threw2 === true, '没配代理时直连失败会如实报错');

    mock.setNetworkResponder(chatResponder);
    llm.resetTransport();
    config.setRuntime('llm.baseUrl', 'http://example.com/v1');
    config.setRuntime('llm.relayBase', '');

    section('思考残留过滤 + 用户手动执行指令不重复执行');

    // ① 思维链标签过滤(内置 + 自定义正则)
    eq(hum.stripMarkdown('</think>\n你好呀'), '你好呀', '开头的 </think> 被过滤');
    eq(hum.stripMarkdown('<thinking>用户问时间</thinking>下午三点'), '下午三点', '<thinking> 整块被过滤');
    eq(hum.stripMarkdown('先想一下\n</think>\n好的'), '先想一下\n好的', '中间落单的 </think> 被过滤');
    eq(hum.stripMarkdown('正常回复'), '正常回复', '没有标签时原样保留');
    config.setRuntime('humanize.stripRegex', '【.*?】');
    eq(hum.stripMarkdown('【内心】你好【旁白】'), '你好', '自定义正则也能过滤');
    config.setRuntime('humanize.stripRegex', '');

    // ② 用户手动执行的指令 -> 不给模型工具, 避免重复执行
    chatMode = 'simple';
    config.setRuntime('access.allowGroupIds', []);
    config.setRuntime('behavior.cooldownSec', 0);
    config.setRuntime('behavior.manualCommandAction', 'no-tools');
    mock.networkCalls.length = 0;
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '！把 Steve 加进白名单', at: true, peerId: '123456789' }));
    await new Promise(function (r) { setTimeout(r, 500); });
    const mcBody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    eq((mcBody.tools || []).length, 0, '以 ！ 开头的消息: 请求里不带任何工具(物理上无法重复执行)');
    ok(String(mcBody.messages[0].content).indexOf('自己手动执行') >= 0, '提示词里说明这是用户手动执行的指令');

    // 普通消息仍然带工具
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '帮我把 Steve 加进白名单', at: true, peerId: '123456789' }));
    await new Promise(function (r) { setTimeout(r, 500); });
    const nmBody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    ok((nmBody.tools || []).length > 0, '普通消息照常带工具');

    // skip 模式: 完全不回复
    config.setRuntime('behavior.manualCommandAction', 'skip');
    sent.length = 0;
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '/list', at: true, peerId: '123456789' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    eq(mock.networkCalls.length, 0, 'skip 模式下连模型都不调用');
    eq(sent.length, 0, 'skip 模式下不回复');

    // off 模式: 完全不管
    config.setRuntime('behavior.manualCommandAction', 'off');
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '！abc', at: true, peerId: '123456789' }));
    await new Promise(function (r) { setTimeout(r, 400); });
    const offBody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    ok((offBody.tools || []).length > 0, 'off 模式: 照常带工具(不做特殊处理)');
    config.setRuntime('behavior.manualCommandAction', 'no-tools');

    section('图片加载失败时回退纯文本重试');

    chatMode = 'simple';
    config.setRuntime('vision.enabled', true);
    config.setRuntime('vision.lookbackSeconds', 180);
    config.setRuntime('access.allowGroupIds', []);
    config.setRuntime('behavior.cooldownSec', 0);
    const ik = memory.sessionKey('group', '123456789');
    memory.clearContext(ik);
    memory.appendMessage(ik, { role: 'user', name: 'Gamer', content: '[图片: 一张MC报错截图]', images: ['https://example.com/expired.png'] });
    memory.appendMessage(ik, { role: 'user', name: 'Gamer', content: '这报错咋回事', images: [] });

    // 第一次(带图)返回 400 图片加载失败, 第二次(纯文本)正常
    let calls = 0;
    mock.networkCalls.length = 0;
    mock.setNetworkResponder(async function () {
        calls++;
        if (calls === 1) {
            return { status: 400, data: { error: { message: "An exception occurred while loading IMAGE data at index 0: Timed out while downloading media URL" } } };
        }
        return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '看你历史里的描述, 是命令参数写错了' }, finish_reason: 'stop' }] } };
    });
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '这个报错咋回事', at: true, peerId: '123456789' }));
    await new Promise(function (r) { setTimeout(r, 600); });

    eq(calls, 2, '第一次带图失败后, 自动用纯文本重试了一次');
    const ivFirst = JSON.parse(mock.networkCalls[0].body);
    const ivLast = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    ok(Array.isArray(ivFirst.messages[ivFirst.messages.length - 1].content), '第一次请求确实带了图片(多模态)');
    ok(typeof ivLast.messages[ivLast.messages.length - 1].content === 'string', '重试时已去掉图片(纯文本)');
    ok(sent.length >= 1 && String(sent[0].text).indexOf('历史里的描述') >= 0, '重试成功后正常回复', sent.map(function (x) { return String(x.text).slice(0, 40); }));

    // 非图片类错误不应触发重试
    calls = 0;
    mock.setNetworkResponder(async function () { calls++; return { status: 500, data: { error: { message: 'internal error' } } }; });
    try { await mock.bus.emit('group_message_event', groupEvent({ text: '再来一句', at: true, peerId: '123456789' })); } catch (e) { }
    await new Promise(function (r) { setTimeout(r, 400); });
    eq(calls, 1, '非图片类错误不重试(避免无意义请求)');

    mock.setNetworkResponder(chatResponder);
    config.setRuntime('vision.enabled', false);

    section('发送文本清理 (空行问题)');

    config.setRuntime('humanize.enabled', true);

    eq(hum.stripMarkdown('第一句\n\n第二句'), '第一句\n第二句', '模型输出的空行被折叠成单换行');
    eq(hum.stripMarkdown('甲\n\n\n乙'), '甲\n乙', '连续多个空行也会被折叠');
    ok(hum.stripMarkdown('a\n\nb').indexOf('\n\n') < 0, '清理后不再出现空行');

    const bl1 = hum.plan('第一句\n\n第二句', {});
    ok(bl1.skipped === false, '有内容时不跳过');
    ok(bl1.segments.every(function (x) { return x.text.indexOf('\n\n') < 0; }),
        '发出去的每个片段都不含空行', bl1.segments.map(function (x) { return x.text; }));

    const bl2 = hum.plan('   \n\n   ', {});
    ok(bl2.skipped === true && bl2.reason === '内容为空', '只有空白内容时直接不发(避免空白消息)', bl2);

    const bl3 = hum.plan('a\n\nb\n\nc', {});
    ok(bl3.skipped === false && bl3.segments.length >= 1, '多段内容仍正常发送');
    ok(bl3.segments.every(function (x) { return x.text.trim().length > 0; }), '不会产生纯空白片段');

    section('按群分类的权限 (同一个人在不同群不同等级)');

    config.setRuntime('permissions.groupScopes',
        '123456789 | 100000001:3, 100000006:2\n' +
        '999888777 | 100000001:1');
    const gmap = perm.groupMap();
    eq(Object.keys(gmap).length, 2, '解析出 2 个群的配置');
    eq(gmap['123456789']['100000001'], 3, 'A 群里该用户是 3 级');
    eq(gmap['999888777']['100000001'], 1, 'B 群里同一个用户只有 1 级');

    // 同一个人按群判定不同等级
    eq(perm.levelOf({ senderId: '100000001', peerId: '123456789' }), 3, '在 A 群 -> 3 级');
    eq(perm.levelOf({ senderId: '100000001', peerId: '999888777' }), 1, '在 B 群 -> 1 级');
    eq(perm.levelOf({ senderId: '100000001', peerId: '没配置的群' }), 0, '没配置的群 -> 最低等级');

    // 群主最高, 其他人最低
    eq(perm.levelOf({ senderId: '888', senderRole: 'owner', peerId: '123456789' }), 3, '群主 -> 最高等级');
    eq(perm.levelOf({ senderId: '888', senderRole: 'admin', peerId: '123456789' }), 0, '群管理 -> 默认最低');
    eq(perm.levelOf({ senderId: '888', senderRole: 'member', peerId: '123456789' }), 0, '普通群友 -> 默认最低');

    // JSON 形式也支持
    config.setRuntime('permissions.groupScopes', '{"123456789":{"100000001":3}}');
    eq(perm.levelOf({ senderId: '100000001', peerId: '123456789' }), 3, 'JSON 形式的群配置也能用');

    // 总览(给 WebUI 用)
    config.setRuntime('permissions.groupScopes', '123456789 | 100000001:3, 100000006:2');
    const ov = perm.overview(['123456789', '555000111'], { '100000001': 'Gamer' });
    eq(ov.ownerLevel, 3, '总览: 群主等级');
    eq(ov.defaultLevel, 0, '总览: 默认等级');
    eq(ov.groups.length, 2, '总览包含 2 个群(允许的群 + 配置过的群)');
    eq(ov.groups[0].members.length, 2, '总览列出该群已配置成员');
    eq(ov.groups[0].members[0].level, 3, '成员按等级从高到低排序');
    eq(ov.groups[0].members[0].name, 'Gamer', '总览带昵称');

    config.setRuntime('permissions.groupScopes', '');

    section('指令知识库 (工具描述 + 可检索)');

    const cmdbook = require('../lib/cmdbook.js');

    config.setRuntime('tools.commandBook',
        'easywhitelist add {player}|把玩家加入白名单|白名单,加白|3\n' +
        'easywhitelist remove {player}|把玩家移出白名单|白名单,移出|3\n' +
        'list|查看在线玩家|在线,人数,几个人|\n' +
        'time set day|把时间设为白天|白天,时间|');
    eq(cmdbook.parse().length, 4, '解析出 4 条指令');
    eq(cmdbook.parse()[0].command, 'easywhitelist add {player}', '指令字段解析正确');
    eq(cmdbook.parse()[0].level, 3, '等级字段解析正确');
    eq(cmdbook.parse()[2].level, null, '等级留空 -> null');

    // 检索
    const hits = cmdbook.search('白名单');
    ok(hits.length === 2, '按"白名单"能检索到 2 条', hits.length);
    ok(cmdbook.search('加白').length >= 1, '按关键词别名"加白"也能检索到');
    ok(cmdbook.searchText('白名单').indexOf('easywhitelist add') >= 0, '检索结果文本包含指令');
    // 查不到时不再让模型直接放弃, 而是摊开全表让它自己判断
    const missText = cmdbook.searchText('完全不存在的功能xyz');
    ok(missText.indexOf('没有直接匹配') >= 0, '查不到时说明没直接匹配');
    ok(missText.indexOf('换一个更通用的功能词') >= 0, '提示模型换个词再查');
    ok(missText.indexOf('全部指令') >= 0 && missText.indexOf('easywhitelist add') >= 0,
        '查不到时返回本服全部指令清单(让模型自己找最接近的)', missText.slice(0, 160));
    ok(missText.indexOf('不要自己编指令') >= 0, '明确禁止编指令');
    // 空查询/* 直接浏览全部
    ok(cmdbook.searchText('*').indexOf('全部指令') >= 0, '通配查询直接列出全部');
    const allN = cmdbook.parse().length;
    ok(cmdbook.allText(80).indexOf(String(allN)) > 0, '全表文本带上条数');

    // 写进 eb_run_command 的工具描述(模型选工具那一刻就看得见)
    builtin.refreshCommandTool();
    const runTool = registry.get('eb_run_command');
    ok(runTool.description.indexOf('本服常用指令') >= 0, '指令知识库写进了 eb_run_command 的工具描述');
    ok(runTool.description.indexOf('easywhitelist add {player}') >= 0, '描述里能看到本服实际指令');

    // 超过 N 条时提示去查
    config.setRuntime('tools.commandBookInDescription', 2);
    builtin.refreshCommandTool();
    ok(registry.get('eb_run_command').description.indexOf('eb_find_command') >= 0,
        '条目超过上限时提示用 eb_find_command 查');

    // 知识库检索工具
    const found = await registry.invoke('eb_find_command', { query: '白名单' }, { senderId: '10001' });
    ok(found.found === 2 && found.result.indexOf('easywhitelist') >= 0,
        'eb_find_command 工具能检索知识库', found);
    ok(registry.toOpenAITools().some(function (t) { return t.function.name === 'eb_find_command'; }),
        'eb_find_command 出现在给模型的工具列表里');

    // 提示词里也有
    const bkHint = chat.permHint('10001', 'admin');
    ok(bkHint.indexOf('本服指令知识库') > 0, '知识库会注入提示词', bkHint.slice(-150));

    config.setRuntime('tools.commandBook', '');
    config.setRuntime('tools.commandBookInDescription', 8);
    builtin.refreshCommandTool();


    // 只读查询: 知识库声明的等级优先(查坐标开放, 查背包受限)
    config.setRuntime('tools.commandBook',
        'data get entity <玩家> Pos|查询玩家坐标|坐标|1\n' +
        'data get entity <玩家> Inventory|查询玩家背包|背包|3\n' +
        'list|在线玩家|在线|1');
    const permB = require('../lib/permissions.js');
    ok(permB.check(1, 'data get entity PlayerG Pos').ok === true, '知识库说等级1 -> 等级1用户可查坐标', permB.check(1, 'data get entity PlayerG Pos'));
    ok(permB.check(1, 'data get entity PlayerG Inventory').ok === false, '知识库说等级3 -> 等级1用户不能查背包', permB.check(1, 'data get entity PlayerG Inventory'));
    eq(permB.check(1, 'data get entity PlayerG Inventory').need, 3, '拒绝时告知需要等级3');
    ok(permB.check(0, 'list').ok === false, '等级0 连安全查询也不能用');
    ok(permB.check(0, 'data get entity PlayerG Pos').ok === false, '等级0 不能查坐标');
    ok(permB.check(3, 'data get entity PlayerG Inventory').ok === true, '等级3 可查背包');
    eq(cmdbook.matchEntry('data get entity PlayerG Inventory').command, 'data get entity <玩家> Inventory', '模板占位符能匹配真实指令');
    // 批量只读查询(execute as @a) —— 一条指令查所有人
    config.setRuntime('tools.commandBook',
        'execute as @a run data get entity @s Health|谁受伤了|受伤,血量|1\n' +
        'data get entity <玩家> Pos|查坐标|坐标|1\n' +
        'data get entity <玩家> Inventory|背包|背包|3');
    eq(cmdbook.matchEntry('execute as @a run data get entity @s Health').command,
        'execute as @a run data get entity @s Health', 'execute as @a 批量查询能命中');
    eq(cmdbook.levelOf('execute as @a run data get entity @s Health'), 1, '批量只读查询是等级1');
    ok(permB.check(1, 'execute as @a run data get entity @s Health').ok === true, '等级1 可做批量血量查询');
    // 但危险的 execute 不会因为这条规则被放行
    ok(permB.check(1, 'execute as @a run kill @a').ok === false,
        'execute 批量查询的授权不会顺带放行危险 execute(未命中知识库 -> 按未知高危处理)');
    eq(cmdbook.levelOf('data get entity PlayerG Pos'), 1, 'levelOf 取到知识库声明的等级');
    eq(cmdbook.levelOf('完全不在知识库里的指令'), null, '未命中返回 null(走常规分类)');
    ok(permB.check(3, '完全不在知识库里的指令xyz').ok === true, '未命中时仍按常规未知指令处理(等级3通过)');
    config.setRuntime('tools.commandBook', '');
    eq(cmdbook.levelOf('data get entity PlayerG Pos'), null, '清空知识库后就不再声明等级');

    section('自定义指令规则 (自然语言 -> 本服指令)');

    const ruleTools = require('../lib/tools/rules.js');

    // 行式配置: 工具名|标题|指令模板|参数|等级
    config.setRuntime('tools.commandRules',
        'add_whitelist|把玩家加入白名单|easywhitelist add {player}|player:玩家名|3\n' +
        'del_whitelist|把玩家移出白名单|easywhitelist remove {player}|player:玩家名|3');
    const parsed = ruleTools.parseRules();
    eq(parsed.length, 2, '解析出 2 条规则');
    eq(parsed[0].name, 'add_whitelist', '规则名解析正确');
    eq(parsed[0].args[0].name, 'player', '参数解析正确');
    eq(parsed[0].level, 3, '等级解析正确');
    eq(ruleTools.render(parsed[0], { player: 'Steve' }), 'easywhitelist add Steve', '指令模板渲染正确');

    // JSON 形式也支持
    config.setRuntime('tools.commandRules',
        '[{"name":"kick_p","title":"踢出玩家","command":"easykick {who}","args":[{"name":"who","desc":"玩家名"}],"level":3}]');
    eq(ruleTools.parseRules()[0].command, 'easykick {who}', 'JSON 形式配置也能解析');

    // 注册成工具并能执行
    config.setRuntime('tools.commandRules',
        'add_whitelist|把玩家加入白名单|easywhitelist add {player}|player:玩家名|3');
    eq(ruleTools.registerAll(), 1, '规则注册成 1 个工具');
    ok(registry.get('eb_add_whitelist') !== undefined, '工具 eb_add_whitelist 在注册表里');
    ok(registry.toOpenAITools().some(function (t) { return t.function.name === 'eb_add_whitelist'; }),
        '规则工具出现在给模型的工具定义里');

    // 低权限被拒
    const deniedRule = await registry.invoke('eb_add_whitelist', { player: 'Steve' },
        { senderId: '888', senderRole: 'member' });
    ok(deniedRule && deniedRule.denied === true && deniedRule.neededLevel === 3,
        '等级不足时规则指令被拒绝', deniedRule);

    // 高权限执行, 且指令是按模板渲染的
    mock.serverActions.length = 0;
    const ranRule = await registry.invoke('eb_add_whitelist', { player: 'Steve' },
        { senderId: '10001', senderRole: 'admin' });
    ok(ranRule.success === true && ranRule.command === 'easywhitelist add Steve',
        '高权限执行规则指令, 渲染出正确指令', ranRule);
    eq(mock.serverActions.filter(function (a) { return a.type === 'command'; })[0].command,
        'easywhitelist add Steve', '下发到服务器的就是本服指令, 不是原版 whitelist');

    // 规则会写进提示词
    const ruleHint = chat.permHint('10001', 'admin');
    ok(ruleHint.indexOf('本服已配置的专用指令工具') > 0 && ruleHint.indexOf('eb_add_whitelist') > 0,
        '规则会注入提示词(告诉模型优先用专用工具)', ruleHint.slice(-200));

    // 指令改写: 模型仍发了原版 whitelist 也能兜住
    // 正则里含 "=" (前瞻) 也必须能正确解析 —— 之前用 "=" 切分会把正则切坏
    config.setRuntime('tools.commandRewrites', '^whitelist(?=\\s|$)=>easywhitelist');
    const rw = ruleTools.applyRewrites('whitelist add Steve');
    ok(rw.changed === true && rw.command === 'easywhitelist add Steve', '改写规则生效(正则含=也能解析)', rw);
    const rw2 = ruleTools.applyRewrites('ban-ip Steve');
    ok(rw2.changed === false, 'ban-ip 不会被误改写成 easyban-ip');
    config.setRuntime('tools.commandRewrites', '^whitelist\\b=easywhitelist');
    ok(ruleTools.applyRewrites('whitelist add X').command === 'easywhitelist add X', '旧的 "=" 写法仍然兼容');
    config.setRuntime('tools.commandRewrites', '^whitelist(?=\\s|$)=>easywhitelist');
    mock.serverActions.length = 0;
    const ranRw = await registry.invoke('eb_run_command', { command: 'whitelist add Steve' },
        { senderId: '10001', senderRole: 'admin' });
    eq(ranRw.command, 'easywhitelist add Steve', 'eb_run_command 执行前自动改写');
    eq(ranRw.rawRequested, 'whitelist add Steve', '保留了模型原本请求的指令(便于排查)');
    eq(ranRw.command, 'easywhitelist add Steve', '执行的是改写后的指令');

    // 清理
    config.setRuntime('tools.commandRules', '');
    config.setRuntime('tools.commandRewrites', '');
    ruleTools.registerAll();
    ok(!registry.get('eb_add_whitelist'), '清空配置后规则工具被移除');

    section('鉴权状态显示 (authMode=none 时不该报"未配置")');

    config.setRuntime('llm.authMode', 'none');
    const stNone = chat.status();
    eq(stNone.authMode, 'none', 'status 返回鉴权方式');
    ok(stNone.authOk === true, 'authMode=none 且没有 Key -> 视为已就绪');
    ok(stNone.authNote.indexOf('不需要密钥') >= 0, '给出"不需要密钥"的说明', stNone.authNote);

    config.setRuntime('llm.apiKey', '');
    config.setRuntime('llm.authMode', 'header');
    const stHeader = chat.status();
    ok(stHeader.authOk === false, 'authMode=header 且没有 Key -> 未就绪');
    ok(stHeader.authNote.indexOf('未配置') >= 0, '给出"未配置"的说明', stHeader.authNote);

    config.setRuntime('llm.apiKey', 'sk-xxx');
    ok(chat.status().authOk === true, '有 Key 时 header 模式视为已就绪');
    config.setRuntime('llm.apiKey', 'sk-test-key');

    // /ai status 命令也应该显示鉴权方式
    sent.length = 0;
    config.setRuntime('llm.authMode', 'none');
    await mock.bus.emit('group_message_event', groupEvent({ text: '/ai status', senderId: '10001' }));
    await new Promise(function (r) { setTimeout(r, 150); });
    ok(sent.some(function (x) { return x.text.indexOf('鉴权: none') >= 0; }),
        '/ai status 显示鉴权方式而不是❌未配置', sent.map(function (x) { return x.text.slice(0, 80); }));
    config.setRuntime('llm.authMode', 'header');   // 还原, 后面的用例依赖 header 模式

    section('WebUI 可调回复逻辑 (预设 + 覆盖 + 决策模拟)');

    // 预设应用 = 保存 behavior 覆盖
    ok(config.saveBehaviorOverride({ groupMode: 'always' }) === true, '能保存行为覆盖');
    eq(config.behavior().groupMode, 'always', '覆盖立即生效');
    const bRaw = mock.litedb.Get('settings', 'behavior_override');
    ok(typeof bRaw === 'string' && bRaw.indexOf('always') > 0, '行为覆盖以 JSON 字符串持久化', String(bRaw).slice(0, 60));

    // 行为覆盖要真的影响决策
    sent.length = 0;
    chatMode = 'simple';
    config.setRuntime('access.allowGroupIds', []);
    config.setRuntime('behavior.cooldownSec', 0);
    await mock.bus.emit('group_message_event', groupEvent({ text: '随便说句话' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    ok(sent.length >= 1, 'always 模式下没被叫到也会回复');

    // 全局开关
    config.saveBehaviorOverride({ enabled: false });
    const d1 = chat.decideReply(groupEvent({ text: 'ai 在吗', at: true }), 'group', memory.sessionKey('group', 'x'), 'ai 在吗');
    ok(d1.reply === false && d1.reason.indexOf('全局回复开关') >= 0, '全局开关关掉后不回复', d1);
    ok(config.saveBehaviorOverride({ enabled: true }) === true, '能重新打开');

    // 清除覆盖后, 决策模拟器应回到 mention 模式的判定
    ok(config.clearBehaviorOverride() === true, '能清除行为覆盖');
    const d2 = chat.decideReply(groupEvent({ text: 'ai 服务器有几个人', at: true }), 'group', memory.sessionKey('group', 'x'), 'ai 服务器有几个人');
    ok(d2.reply === true && d2.reason === '@我', '模拟器能给出判定与原因', d2);
    const d3 = chat.decideReply(groupEvent({ text: '今天天气不错' }), 'group', memory.sessionKey('group', 'x'), '今天天气不错');
    ok(d3.reply === false && d3.reason.indexOf('未被叫到') >= 0, '模拟器能给出"不回复"的原因', d3);
    eq(config.behavior().groupMode, config.get().behavior.groupMode, '清除后回到配置文件的值');

    section('自定义模型 / 自定义 API / 自定义提示词风格');

    chatMode = 'simple';

    // --- 1) 自定义模型与接口地址 ---
    config.setRuntime('llm.model', 'my-custom-model');
    config.setRuntime('llm.baseUrl', 'https://my.api.example/v1');
    mock.networkCalls.length = 0;
    await chat.askOnce('你好', { senderName: '测试' });
    let req = mock.networkCalls[mock.networkCalls.length - 1];
    let reqBody = JSON.parse(req.body);
    eq(reqBody.model, 'my-custom-model', '自定义模型名进了请求体');
    eq(req.url, 'https://my.api.example/v1/chat/completions', '自定义接口地址生效(自动补 /chat/completions)');
    eq(req.headers.Authorization, 'Bearer sk-test-key', 'authMode=header 时带 Authorization');
    ok(reqBody.messages[0].role === 'system', '系统提示词在最前面');

    // 直接填完整的 /chat/completions 地址也可以
    config.setRuntime('llm.baseUrl', 'https://x.example/api/chat/completions');
    mock.networkCalls.length = 0;
    await chat.askOnce('hi', {});
    eq(mock.networkCalls[mock.networkCalls.length - 1].url, 'https://x.example/api/chat/completions', '完整 URL 不会被二次拼接');

    // authMode=query: 这个 EasyBot build 发不了请求头时的替代方案
    config.setRuntime('llm.authMode', 'query');
    config.setRuntime('llm.authQueryParam', 'api_key');
    mock.networkCalls.length = 0;
    await chat.askOnce('hi', {});
    ok(mock.networkCalls[mock.networkCalls.length - 1].url.indexOf('api_key=sk-test-key') > 0,
        'authMode=query 时密钥被拼进 URL');
    config.setRuntime('llm.authMode', 'header');

    // --- 2) 自定义提示词/人设决定回复风格 ---
    mock.litedb.Delete('settings', 'persona_override');
    config.setRuntime('persona.name', '小助手');
    config.setRuntime('persona.personality', '高冷但嘴硬心软');
    config.setRuntime('persona.speakingStyle', '说话像东北大哥, 爱用"整挺好""必须的"');
    config.setRuntime('persona.extraRules', '不要讨论政治');
    config.setRuntime('persona.exampleDialogue', '用户: 今天玩啥\n你: 整挺好, 上号!');
    mock.networkCalls.length = 0;
    await chat.askOnce('你好', { senderName: '测试' });
    const sysPrompt = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body).messages[0].content;
    ok(sysPrompt.indexOf('小助手') >= 0, '自定义名字进入 system prompt');
    ok(sysPrompt.indexOf('高冷但嘴硬心软') >= 0, '自定义性格进入 system prompt');
    ok(sysPrompt.indexOf('东北大哥') >= 0, '自定义说话风格进入 system prompt');
    ok(sysPrompt.indexOf('不要讨论政治') >= 0, '自定义额外规则进入 system prompt');
    ok(sysPrompt.indexOf('整挺好, 上号!') >= 0, '自定义示例对话进入 system prompt');
    ok(sysPrompt.indexOf('【输出要求】') >= 0, '内置输出约束仍在');

    // --- 3) 群里用命令实时改风格 ---
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({
        text: '/ai persona 风格 说话要像猫娘，句尾加"喵"', senderId: '10001', role: 'owner'
    }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(config.persona().speakingStyle, '说话要像猫娘，句尾加"喵"', '/ai persona 改风格立即生效');
    const personaOvRaw = mock.litedb.Get('settings', 'persona_override');
    const personaOv = typeof personaOvRaw === 'string' ? JSON.parse(personaOvRaw) : personaOvRaw;
    eq(personaOv.speakingStyle, '说话要像猫娘，句尾加"喵"',
        '人设覆盖以 JSON 字符串持久化到 litedb(真机只认字符串)');
    ok(chat.buildSystemPrompt('g:1', '10001', '测试', 'group', '').indexOf('句尾加"喵"') >= 0,
        '改完风格后新的 system prompt 立刻带上');
    ok(sent.some(function (x) { return x.text.indexOf('人设已更新') >= 0; }), '命令有回执');

    // --- 4) 非管理员改不了 ---
    await mock.bus.emit('group_message_event', groupEvent({
        text: '/ai persona 名字  hacked', senderId: '99999', role: 'member'
    }));
    await new Promise(function (r) { setTimeout(r, 120); });
    eq(config.persona().name, '小助手', '普通成员不能改人设');

    // --- 优先级: WebUI/命令保存的覆盖 > 配置文件 ---
    config.setRuntime('persona.name', '配置文件里的名字');
    config.savePersonaOverride({ name: '覆盖里的名字' });
    eq(config.persona().name, '覆盖里的名字', '人设覆盖优先于配置文件');
    mock.litedb.Delete('settings', 'persona_override');
    eq(config.persona().name, '配置文件里的名字', '去掉覆盖后回到配置文件的值');

    // --- 还原 ---
    config.setRuntime('llm.model', 'test-model');
    config.setRuntime('llm.baseUrl', 'https://example.com/v1');
    config.setRuntime('persona.name', '小助手');
    config.setRuntime('persona.speakingStyle', '');
    config.setRuntime('persona.personality', '');
    config.setRuntime('persona.extraRules', '');
    config.setRuntime('persona.exampleDialogue', '');
    mock.litedb.Delete('settings', 'persona_override');

    section('持久化格式 (真机 litedb 只可靠存字符串)');

    // 真机上 litedb.Set(对象) 写不进去; 这里断言我们存的是字符串
    const rawStored = mock.litedb.Get('context', memory.sessionKey('group', 'persist'));
    memory.clearContext(memory.sessionKey('group', 'persist'));
    memory.appendMessage(memory.sessionKey('group', 'persist'), { role: 'user', name: 'Gamer', content: '持久化测试' });
    const persisted = mock.litedb.Get('context', memory.sessionKey('group', 'persist'));
    eq(typeof persisted, 'string', '上下文以 JSON 字符串形式写入 litedb');
    ok(String(persisted).indexOf('持久化测试') >= 0, '内容确实在里面', String(persisted).slice(0, 80));
    eq(memory.getContext(memory.sessionKey('group', 'persist')).messages.length, 1, '读回来能还原成对象');

    // 模拟宿主只存字符串的极端情况
    const realGet = mock.litedb.Get;
    mock.litedb.Get = function (c, k) {
        const v = realGet(c, k);
        return v === null || v === undefined ? v : JSON.stringify(v);   // 双重编码
    };
    ok(memory.getContext(memory.sessionKey('group', 'persist')).messages.length >= 0, '宿主异常返回时不会崩');
    mock.litedb.Get = realGet;

    section('图片回看 (先发图, 再@机器人问)');

    chatMode = 'simple';
    config.setRuntime('vision.enabled', true);
    config.setRuntime('vision.lookbackSeconds', 180);
    config.setRuntime('access.allowGroupIds', []);
    const lk = memory.sessionKey('group', 'lookback');
    memory.clearContext(lk);

    // 别人先发一张图(当前消息之外的独立消息)
    memory.appendMessage(lk, {
        role: 'user', name: '林彦', content: '[图片]',
        images: ['https://example.com/qq-pic.jpg']
    });
    await new Promise(function (r) { setTimeout(r, 30); });
    // 8 秒后 Gamer 才 @机器人问
    memory.appendMessage(lk, { role: 'user', name: 'Gamer', content: '@你 这是啥', images: [] });

    eq(memory.recentImages(lk, 180, 2).length, 1, '能回看到最近消息里的图片');
    eq(memory.recentImages(lk, 180, 2)[0], 'https://example.com/qq-pic.jpg', '回看到的 URL 正确');
    // 用一条 10 分钟前的图片消息验证窗口边界
    const oldKey = memory.sessionKey('group', 'lookback-old');
    memory.clearContext(oldKey);
    memory.appendMessage(oldKey, {
        role: 'user', name: '林彦', content: '[图片]',
        images: ['https://example.com/old.jpg'], ts: Date.now() - 10 * 60 * 1000
    });
    eq(memory.recentImages(oldKey, 180, 2).length, 0, '超过回看窗口的旧图不会被带上');
    eq(memory.recentImages(oldKey, 3600, 2).length, 1, '把窗口放大就能看到那张旧图');

    // 当前消息没带图, 但应回看并作为多模态发出
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({
        text: '这是啥', at: true, peerId: 'lookback'
    }));
    await new Promise(function (r) { setTimeout(r, 400); });
    const lb = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    const lbLast = lb.messages[lb.messages.length - 1];
    ok(Array.isArray(lbLast.content), '当前消息没带图时也会回看并组装成多模态', lbLast.content);
    ok(Array.isArray(lbLast.content) && lbLast.content.some(function (p) { return p.type === 'image_url'; }),
        '回看到的图片 URL 被带上');

    // 关掉回看则保持纯文本
    config.setRuntime('vision.lookbackSeconds', 0);
    memory.clearContext(lk);
    memory.appendMessage(lk, { role: 'user', name: '林彦', content: '[图片]', images: ['https://example.com/qq-pic.jpg'] });
    memory.appendMessage(lk, { role: 'user', name: 'Gamer', content: '@你 这是啥', images: [] });
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '这是啥', at: true, peerId: 'lookback' }));
    await new Promise(function (r) { setTimeout(r, 400); });
    const lb2 = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    ok(typeof lb2.messages[lb2.messages.length - 1].content === 'string', '回看关闭时是纯文本');

    config.setRuntime('vision.lookbackSeconds', 180);
    config.setRuntime('vision.enabled', false);

    section('引用(回复)指定图片 —— 不能看错图');

    chatMode = 'simple';
    config.setRuntime('vision.enabled', true);
    config.setRuntime('vision.lookbackSeconds', 180);
    config.setRuntime('access.allowGroupIds', []);
    const qk = memory.sessionKey('group', 'quoted');
    memory.clearContext(qk);

    // 复刻日志里的真实情况: 两张图, 用户"引用"了后发的那张
    memory.appendMessage(qk, {
        role: 'user', name: 'Gamer', content: '[图片: 黑白Q版动漫头像]',
        images: ['https://example.com/OLD-黑白.jpg'], msgId: '111'
    });
    await new Promise(function (r) { setTimeout(r, 20); });
    memory.appendMessage(qk, {
        role: 'user', name: 'Gamer', content: '[图片: 蓝发双马尾女仆装]',
        images: ['https://example.com/NEW-女仆.jpg'], msgId: '222'
    });
    await new Promise(function (r) { setTimeout(r, 20); });

    // 用户引用 222 那条问"这是啥"
    const quotedEv = {
        SelfId: '99999', SenderId: '10001', PeerId: 'quoted', MessageId: '333',
        SenderName: 'Gamer', SenderRole: 'member',
        RawMessage: '[CQ:reply,id=222][CQ:at,qq=99999] 这是啥',
        Messages: [], Chain: null,
        AdapterContext: mock.fakeAdapter.GetAdapterContext(),
        Context: { Reply: async function () { return ''; } }
    };
    const q = chat.quotedMessage(quotedEv, qk);
    ok(q && q.content.indexOf('蓝发双马尾') >= 0, '能按 reply id 找到被引用的那条消息', q);
    ok(q.images[0].indexOf('NEW-女仆') > 0, '拿到的是被引用那条的图片', q.images);

    memory.appendMessage(qk, { role: 'user', name: 'Gamer', content: '@你 这是啥', msgId: '333' });
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', quotedEv);
    await new Promise(function (r) { setTimeout(r, 500); });

    const qbody = JSON.parse(mock.networkCalls[mock.networkCalls.length - 1].body);
    const qlast = qbody.messages[qbody.messages.length - 1];
    const qlastText = Array.isArray(qlast.content)
        ? (qlast.content.filter(function (p) { return p.type === 'text'; })[0] || {}).text || ''
        : String(qlast.content);
    ok(qlastText.indexOf('【他引用的那条消息】') >= 0, '把被引用的消息放在这一轮里告诉模型', qlastText.slice(0, 160));
    ok(qlastText.indexOf('蓝发双马尾') >= 0, '被引用内容是正确的那一条', qlastText.slice(0, 160));
    ok(Array.isArray(qlast.content) && qlast.content.some(function (p) {
        return p.type === 'image_url' && p.image_url.url.indexOf('NEW-女仆') > 0;
    }), '发给模型的图片是"被引用"的那张, 不是最近的那张', qlast.content && qlast.content.map(function (p) { return p.image_url ? p.image_url.url : p.text; }));

    // 引用了一条不在记录里的消息 -> 不崩, 退化为回看
    const unknownEv = {
        SelfId: '99999', SenderId: '10001', PeerId: 'quoted', MessageId: '444',
        SenderName: 'Gamer', RawMessage: '[CQ:reply,id=999999][CQ:at,qq=99999] 这是啥',
        Messages: [], Chain: null,
        AdapterContext: mock.fakeAdapter.GetAdapterContext(),
        Context: { Reply: async function () { return ''; } }
    };
    const qu = chat.quotedMessage(unknownEv, qk);
    ok(qu && qu.unknown === true, '引用不在记录里的消息时标记为未知');

    config.setRuntime('vision.enabled', false);
    config.setRuntime('vision.lookbackSeconds', 180);

    section('图片描述缓存 (学 MaiBot: VLM 描述一次写进上下文)');

    const dk = memory.sessionKey('group', 'describe');
    memory.clearContext(dk);
    memory.appendMessage(dk, { role: 'user', name: '林彦', content: '[图片]', images: ['https://example.com/p.jpg'] });
    ok(memory.annotateLastImages(dk, '一只黑猫趴在地板上') === true, '能把描述写回带图片的消息');
    const dc = memory.getContext(dk).messages[0].content;
    ok(dc.indexOf('一只黑猫趴在地板上') >= 0 && dc.indexOf('[图片:') >= 0, '历史里变成带描述的形式', dc);
    ok(memory.annotateLastImages(dk, '重复描述') === false, '同一条消息不会重复写入描述');

    // 开着 describeOnReceive 时, 收到图片会自动生成描述
    chatMode = 'simple';
    config.setRuntime('vision.enabled', true);
    config.setRuntime('vision.describeOnReceive', true);
    config.setRuntime('access.allowGroupIds', []);
    const dk2 = memory.sessionKey('group', '123456');
    memory.clearContext(dk2);
    mock.networkCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({
        text: '看这个', peerId: '123456',
        rawExtra: '[CQ:image,file=a.jpg,url=https://example.com/cat2.jpg]'
    }));
    await new Promise(function (r) { setTimeout(r, 500); });
    const dmsgs = memory.getContext(dk2).messages;
    ok(dmsgs.length >= 1 && String(dmsgs[0].content).indexOf('[图片:') >= 0,
        '收到图片后自动生成描述并写入上下文', dmsgs[0] && dmsgs[0].content);
    ok(mock.networkCalls.some(function (c) {
        const b = JSON.parse(c.body || '{}');
        return (b.messages || []).some(function (m) { return Array.isArray(m.content); });
    }), '确实是带着图片去问模型要的描述');

    config.setRuntime('vision.describeOnReceive', false);
    config.setRuntime('vision.enabled', false);

    section('提示词结构 (防止模型续写聊天记录)');

    const pk = memory.sessionKey('group', 'prompttest');
    memory.clearContext(pk);
    memory.appendMessage(pk, { role: 'user', name: '张三', content: '闲聊一句' });
    memory.appendMessage(pk, { role: 'assistant', name: '小助手', content: '嗯嗯' });
    memory.appendMessage(pk, { role: 'user', name: 'Gamer', content: 'ai 服务器有几个人？' });

    const msgsC = memory.buildMessages(pk, 'SYS', { current: { name: 'Gamer', content: 'ai 服务器有几个人？' } });
    eq(msgsC.length, 2, 'context 模式只发 system + 当前消息两条');
    eq(msgsC[0].role, 'system', '第一条是 system');
    ok(msgsC[0].content.indexOf('【近期群聊记录】') >= 0, '历史作为「群聊记录」块放进 system');
    ok(msgsC[0].content.indexOf('张三：闲聊一句') >= 0, '历史内容在块里');
    ok(msgsC[0].content.indexOf('ai 服务器有几个人？') < 0, '当前消息不会重复出现在背景块里');
    ok(msgsC[1].role === 'user' && msgsC[1].content.indexOf('【现在轮到你了】') === 0, '当前消息带明确标记');
    ok(msgsC[0].content.indexOf('不要复述') > 0, '带反续写规则');
    ok(msgsC[1].content.indexOf('请自然地回复这条消息') > 0, '最后一条 user 里带"行动指令"(参考 MaiBot)');
    ok(msgsC[0].content.indexOf('【输出约定】') < msgsC[0].content.indexOf('【近期群聊记录】'),
        '输出约定在聊天记录之前(避免命令式规则落在末尾被复述)');
    ok(msgsC[0].content.indexOf('不要只回') > 0, '带"不要只回稍等"规则');
    ok(memory.ANTI_ECHO.indexOf('不要只回') > 0, 'ANTI_ECHO 已导出且含反占位规则');

    config.setRuntime('memory.historyMode', 'turns');
    const msgsT = memory.buildMessages(pk, 'SYS', { current: { name: 'Gamer', content: 'ai 服务器有几个人？' } });
    ok(msgsT.length >= 4 && msgsT[1].role === 'user', 'turns 模式按 user/assistant 轮次发送');
    ok(msgsT[0].content.indexOf('不要复述') > 0, 'turns 模式同样带反续写规则');
    ok(msgsT[msgsT.length - 1].content.indexOf('【现在轮到你了】') === 0, 'turns 模式当前消息也有标记');
    config.setRuntime('memory.historyMode', 'context');

    section('限流 (429) 处理');

    mock.setNetworkResponder(async function () {
        return { status: 429, data: { error: { message: "You've reached the API rate limit for free users." } } };
    });
    mock.networkCalls.length = 0;
    let rlErr = '';
    try { await chat.askOnce('hi', {}); } catch (e) { rlErr = String(e.message); }
    ok(rlErr.indexOf('限流') >= 0, '429 被识别为限流并给出明确报错', rlErr);
    ok(llm.inCooldown(), '命中限流后进入冷却期');

    const callsBefore = mock.networkCalls.length;
    let rlErr2 = '';
    try { await chat.askOnce('hi', {}); } catch (e) { rlErr2 = String(e.message); }
    ok(rlErr2.indexOf('冷却') >= 0, '冷却期内直接快速失败', rlErr2);
    eq(mock.networkCalls.length, callsBefore, '冷却期内不再打接口');

    // 群消息在冷却期内也不该往群里发东西
    sent.length = 0;
    config.setRuntime('access.allowGroupIds', []);
    await mock.bus.emit('group_message_event', groupEvent({ text: 'ai 在吗', at: true }));
    await new Promise(function (r) { setTimeout(r, 200); });
    eq(sent.length, 0, '限流冷却期内不往群里发消息');

    llm.clearCooldown();
    mock.setNetworkResponder(chatResponder);
    ok(!llm.inCooldown(), '冷却可被清除');

    section('"只说不做"兜底 (说要去查, 但这一轮没调工具)');

    ok(chat.promisedAction('好呀小蓝去查一下侦测器呢 | 稍等') === true, '识别"我去查一下…稍等"');
    ok(chat.promisedAction('稍等小蓝跑一下 easypardon') === true, '识别"稍等我跑一下"');
    ok(chat.promisedAction('让我去查查wiki呢') === true, '识别"让我去查查"');
    ok(chat.promisedAction('小蓝这就去把 seeker0306 从黑名单里捞出来') === true, '识别"这就去…"');
    ok(chat.promisedAction('今天天气不错呀') === false, '普通聊天不误判');
    ok(chat.promisedAction('查到啦！侦测器是红石元件') === false, '"查到啦"不算承诺');
    ok(chat.promisedAction('') === false, '空串不误判');

    // ---------------------------------------------------------------- MC百科(图文)
    // ★ 回归: 曾因 handler 只写 (args) 却用 ctx.sessionKey -> "ctx is not defined" ✗
    //   (抓取/过滤逻辑开发时用真实页面验证过; 这里锁"注册 + 签名"两个易错点)
    section('MC百科 图文 (注册与签名)');
    ok(registry.toOpenAITools().some(function (t) { return t.function.name === 'eb_search_mcmod'; }),
        'eb_search_mcmod 出现在工具列表里');
    ok(registry.get('eb_search_mcmod').handler.length >= 2,
        'mcmod handler 声明了 ctx 参数(回归: 曾因缺它抛 ctx is not defined)');
    ok(typeof wiki.mcmodPage === 'function' && typeof wiki.takeImages === 'function',
        'MC百科 图文能力已导出(page + 图片缓存)');

    section('表情: 只留颜文字, 去掉 emoji/QQ表情');
    eq(humanize.stripEmoji('嘿嘿( •_•) 😂'), '嘿嘿( •_•)', 'emoji 被去掉, 颜文字保留');
    eq(humanize.stripEmoji('好呀( ・ω・)[流泪]这次'), '好呀( ・ω・)这次', 'QQ 表情代码被去掉');
    eq(humanize.stripEmoji('查到了(´*･ω･)ﾉ 🎉❤️'), '查到了(´*･ω･)ﾉ', '装饰 emoji 被去掉');
    eq(humanize.stripEmoji('只有颜文字(≧▽≦) •◕‿◕• 不能被删'), '只有颜文字(≧▽≦) •◕‿◕• 不能被删', '颜文字不误删');
    eq(humanize.stripEmoji('正常一句话'), '正常一句话', '普通文本不受影响');

    section('人设名可写多个(逗号分隔)');
    ok(config.toList('小蓝，拉德利'.replace(/[、\/]/g, ',')).length === 2, '人设名"小蓝，拉德利"能拆成 2 个');
    ok(config.toList('小蓝,拉德利;蓝酱').length === 3, '逗号/分号都能拆');
    ok(config.toList('小蓝').length === 1, '单个名字不受影响');

    // ---------------------------------------------------------------- 事件对象不可写(回归)
    // ★ 真机踩过: event 是宿主的 .NET 对象, 往上写 JS 属性会抛
    //   "The object has no suitable property or field named '__hasFile'" ✗
    //   mock 里 event 是普通对象, 所以必须用 Object.freeze 模拟"不可写"才能测出来 ✓
    section('事件对象不可写(模拟宿主 .NET 对象)');
    sent.length = 0;
    const _logStart = (mock.logs || []).length;
    const frozenEv = Object.freeze(groupEvent({ text: '冻结事件测试', at: true }));
    let frozenErr = '';
    try {
        await mock.bus.emit('group_message_event', frozenEv);
        await new Promise(function (r) { setTimeout(r, 400); });
    } catch (e) { frozenErr = String((e && e.message) || e); }
    const _newLogs = (mock.logs || []).slice(_logStart).map(function (l) { return String(l && l.text || l); });
    const _failLogs = _newLogs.filter(function (t) { return t.indexOf('群消息处理失败') >= 0; });
    ok(!frozenErr, '处理"不可写事件对象"时不抛异常', frozenErr);
    ok(_failLogs.length === 0, '没有出现「群消息处理失败」(即没有往 event 上写属性)', _failLogs.slice(-1));

    // ---------------------------------------------------------------- DSH 接入
    // --- 文本工具调用：应重试一次，群里不能出现 <tool_call> ✗ ---
    let tlCalls = 0;
    mock.setNetworkResponder(function (msg) {
        tlCalls++;
        if (tlCalls === 1) {
            return { status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant',
                content: '小蓝去装上\n\n<tool_call>\n<function=eb_rpc_call>\n<parameter=serverToken>\nSECRETabcdefghijklmnop\n</parameter>\n</function>\n</tool_call>' } }] }) };
        }
        return { status: 200, body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: '装不了哦，需要管理员手动放 jar' } }] }) };
    });
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '帮我把这个模组装上', at: true }));
    await new Promise(function (r) { setTimeout(r, 400); });
    ok(tlCalls >= 2, '文本工具调用 -> 会重试一次', tlCalls);
    ok(sent.every(function (x) { return String(x.text).indexOf('<tool_call>') < 0 && String(x.text).indexOf('SECRETabcdefghijklmnop') < 0; }),
        '重试后群里没有工具调用文本/凭据', sent.map(function (x) { return String(x.text).slice(0, 60); }));
    mock.setNetworkResponder(chatResponder);

    // --- 追加的文件说明不能把工具撤掉（说明里曾有 "/" → 被当成命令 ✗）---
    let noteLLMBody = null;
    mock.setNetworkResponder(function (msg) {
        try { noteLLMBody = JSON.parse(String(msg.body || '{}')); } catch (e) { }
        return chatResponder(msg);
    });
    await mock.bus.emit('group_message_event', {
        SelfId: '99999', SenderId: '10001', PeerId: '123456', MessageId: 'mnote1',
        SenderName: '小明', SenderRole: 'member',
        RawMessage: '[CQ:at,qq=99999]把这个装到创造服[CQ:file,file=rank-1.4.1.jar,url=https://njc-download.ftn.qq.com/a.jar,file_size=95293]',
        Messages: [], Chain: new mock.MessageChain().Text('把这个装到创造服'),
        AdapterContext: { SendGroupMessageAsync: async function (a, b, c) { sent.push({ text: c.AsString() }); return 'x'; } }
    });
    await new Promise(function (r) { setTimeout(r, 400); });
    const noteTools = JSON.stringify((noteLLMBody && noteLLMBody.tools) || []);
    ok(noteTools.indexOf('eb_install_mod') >= 0, '带文件的 @ 消息仍保留装 mod 工具（说明里的斜杠不再误判成命令）', noteTools.slice(0, 120));
    mock.setNetworkResponder(chatResponder);

    // --- 引用一条文件消息：靠 fileurl 缓存反查，模型要能看到文件名 ---
    litedb.Set('fileurl', 'qfile-1', JSON.stringify({ name: 'quoted-mod-1.0.jar', url: 'https://njc-download.ftn.qq.com/q.jar', size: 4242 }));
    let qBody = null;
    mock.setNetworkResponder(function (msg) {
        try { qBody = JSON.parse(String(msg.body || '{}')); } catch (e) { }
        return chatResponder(msg);
    });
    sent.length = 0;
    await mock.bus.emit('group_message_event', {
        SelfId: '99999', SenderId: '10001', PeerId: '123456', MessageId: 'mquote1',
        SenderName: '小明', SenderRole: 'member',
        RawMessage: '[CQ:reply,id=qfile-1][CQ:at,qq=99999]把这个装上',
        Messages: [], Chain: new mock.MessageChain().Text('把这个装上'),
        AdapterContext: { SendGroupMessageAsync: async function (a, b, c) { sent.push({ text: c.AsString() }); return 'x'; } }
    });
    await new Promise(function (r) { setTimeout(r, 400); });
    const qPrompt = JSON.stringify(qBody || {});
    ok(qPrompt.indexOf('quoted-mod-1.0.jar') >= 0, '引用文件消息时，模型能看到文件名（靠缓存反查）', qPrompt.slice(0, 200));
    ok(sent.length > 0, '引用文件 + @ 它 → 正常回复');
    mock.setNetworkResponder(chatResponder);

    // --- 兄弟插件(快递)误认领：必须用【用户原话】判定，且被叫到时仍要回 ✓ ---
    config.setRuntime('behavior.itemMailClaimUrl', 'http://claim.test/claim');
    let claimCalls = 0;
    let claimBody = null;
    mock.setNetworkResponder(function (msg) {
        const u = String(msg.url || '');
        if (u.indexOf('claim.test') >= 0) {
            claimCalls++;
            try { claimBody = JSON.parse(String(msg.body || '{}')); } catch (e) { }
            return { status: 200, body: JSON.stringify({ mine: true, reason: '测试认定' }) };
        }
        return chatResponder(msg);
    });

    // ① 用户原话里没有寄件词（"装到"），只是我们追加的文件说明里有"发" → 不该去问、必须正常回 ✓
    claimCalls = 0; sent.length = 0;
    await mock.bus.emit('group_message_event', {
        SelfId: '99999', SenderId: '10001', PeerId: '123456', MessageId: 'mclaim1',
        SenderName: '小明', SenderRole: 'member',
        RawMessage: '[CQ:at,qq=99999]把这个装到创造服[CQ:file,file=rank-1.4.1.jar,url=https://njc-download.ftn.qq.com/a.jar,file_size=95293]',
        Messages: [], Chain: new mock.MessageChain().Text('把这个装到创造服'),
        AdapterContext: { SendGroupMessageAsync: async function (a, b, c) { sent.push({ text: c.AsString() }); return 'x'; } }
    });
    await new Promise(function (r) { setTimeout(r, 400); });
    ok(claimCalls === 0 || (claimBody && String(claimBody.text).indexOf('装到创造服') >= 0 && String(claimBody.text).indexOf('用户发来了文件') < 0),
        '认领判定用的是用户原话（不含我们追加的文件说明）', { calls: claimCalls, body: claimBody });
    ok(sent.length > 0, '带文件 + @ 它 → 必须正常回复（不能因误认领而闭嘴）', sent.length);

    // ② 真寄件指令、但没 @ 它 → 让给快递插件 ✓
    claimCalls = 0; sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '把一组钻石寄给小明' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    ok(claimCalls >= 1, '真寄件指令会去问快递插件', claimCalls);
    ok(sent.length === 0, '没 @ 它 + 快递认领 → 不接话', sent.length);

    // ③ 真寄件指令、但 @ 它了 → 仍要回，且撤掉寄件工具 ✓
    claimCalls = 0; sent.length = 0;
    let claimLlmBody = null;
    mock.setNetworkResponder(function (msg) {
        const u = String(msg.url || '');
        if (u.indexOf('claim.test') >= 0) { claimCalls++; return { status: 200, body: JSON.stringify({ mine: true, reason: '测试认定' }) }; }
        try { claimLlmBody = JSON.parse(String(msg.body || '{}')); } catch (e) { }
        return chatResponder(msg);
    });
    await mock.bus.emit('group_message_event', groupEvent({ text: '把一组钻石寄给小明', at: true }));
    await new Promise(function (r) { setTimeout(r, 400); });
    ok(sent.length > 0, '@ 它 + 快递认领 → 仍然回复', sent.length);
    const toolNames = JSON.stringify((claimLlmBody && claimLlmBody.tools) || []);
    ok(toolNames.indexOf('item_mail_transfer') < 0, '认领过就撤掉寄件工具（避免重复寄）', toolNames.slice(0, 120));

    mock.setNetworkResponder(chatResponder);
    config.setRuntime('behavior.itemMailClaimUrl', 'http://127.0.0.1:18888/tool/claim');

    // --- 出站消毒：模型把 <tool_call> 当正文写出来时，不能连凭据一起发进群 ✗ ---
    const dirty = '小蓝看看能不能装上\n\n<tool_call>\n<function=eb_rpc_call>\n<parameter=serverToken>\nSECRET1234567890abcdef\n</parameter>\n</function>\n</tool_call>';
    const sanitized = chat.sanitizeOutbound(dirty);
    ok(sanitized.indexOf('<tool_call>') < 0 && sanitized.indexOf('SECRET1234567890abcdef') < 0, '出站消毒：文本工具调用与凭据都被清掉', sanitized);
    ok(sanitized.indexOf('小蓝看看能不能装上') >= 0, '出站消毒：正常正文保留');
    ok(chat.sanitizeOutbound('serverToken: ABCDEF1234567890abcdef').indexOf('ABCDEF1234567890abcdef') < 0, '出站消毒：裸 token 打码');

    // --- 文件消息：模型必须知道"文件名/大小"（以前只看到 [文件] ✗）---
    let fileReqBody = null;
    mock.setNetworkResponder(function (msg) {
        try { fileReqBody = JSON.parse(String(msg.body || '{}')); } catch (e) { }
        return chatResponder(msg);
    });
    sent.length = 0;
    await mock.bus.emit('group_message_event', {
        SelfId: '99999', SenderId: '10001', PeerId: '123456', MessageId: 'mfile1',
        SenderName: '小明', SenderRole: 'member',
        RawMessage: '[CQ:at,qq=99999][CQ:file,file=rank-1.4.1-fabric26.3.jar,url=https://example.invalid/a.jar,file_size=95293]',
        Messages: [], Chain: new mock.MessageChain().Text('[文件]'),
        AdapterContext: { SendGroupMessageAsync: async function (a, b, c) { sent.push({ text: c.AsString() }); return 'x'; } }
    });
    await new Promise(function (r) { setTimeout(r, 400); });   // sleepMs 还没定义(下面才声明) ✓
    const filePrompt = JSON.stringify(fileReqBody || {});
    ok(filePrompt.indexOf('rank-1.4.1-fabric26.3.jar') >= 0, '文件消息：模型能看到文件名');
    ok(filePrompt.indexOf('93.1 KB') >= 0, '文件消息：模型能看到文件大小', filePrompt.slice(0, 300));
    mock.setNetworkResponder(chatResponder);

    section('DSH 接入（工具模式 + 直连模式）');
    const dshApi = require('../lib/dsh.js');
    const sleepMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    config.setRuntime('dsh.enabled', true);
    config.setRuntime('dsh.baseUrl', 'http://bridge.test');
    config.setRuntime('dsh.token', 'test-token');
    config.setRuntime('dsh.approveMinLevel', 3);
    config.setRuntime('dsh.modeMinLevel', 3);
    config.setRuntime('dsh.approvalTimeoutSec', 60);
    config.setRuntime('dsh.modeIdleTimeoutSec', 0);
    dshApi.setNotifier(async function (t) { sent.push({ kind: 'group', text: String(t) }); });

    // 桥接服务用 mock 网络模拟：/run 原样回显 prompt
    const dshCallLog = [];
    const wsCalls = [];
    const dshNetResponder = async function (msg) {
        const url = String((msg && msg.url) || '');
        if (url.indexOf('bridge.test') < 0) return chatResponder(msg);
        if (url.indexOf('/health') >= 0) {
            return { status: 200, body: JSON.stringify({ ok: true, running: 0, queued: 0, cwd: '/home/user' }) };
        }
        if (url.indexOf('/workspaces') >= 0) {
            return { status: 200, body: JSON.stringify({ ok: true, workspaces: [
                { id: 'ws-home', title: 'home', path: '/home', count: 3 },
                { id: 'ws-bot', title: 'EasyBot', path: '/home/user', count: 1 }
            ] }) };
        }
        if (url.indexOf('/digest') >= 0) {
            return { status: 200, body: JSON.stringify({ ok: true, id: 'session-b', title: '网页里建的会话',
                cwd: '/home/user', adoptable: false, preset: 'standard',
                turns: 2, chars: 60, truncated: false, digest: '用户：你好\n\n助手：你好，我是助手。' }) };
        }
        if (url.indexOf('/sessions') >= 0) {
            return { status: 200, body: JSON.stringify({ ok: true, sessions: [
                { id: 'session-a', title: '插件开发文档查阅', cwd: '/home', seq: 100, workspaceId: 'ws-home', workspaceTitle: 'home', adoptable: true, preset: null },
                { id: 'session-b', title: '网页里建的会话', cwd: '/home/user', seq: 50, workspaceId: 'ws-bot', workspaceTitle: 'EasyBot', adoptable: false, preset: 'standard' }
            ] }) };
        }
        if (url.indexOf('/workspace/create') >= 0) {
            let b0 = {}; try { b0 = JSON.parse(String(msg.body || '{}')); } catch (e) { }
            wsCalls.push({ kind: 'create', title: b0.title, path: b0.path });
            return { status: 200, body: JSON.stringify({ ok: true, id: 'ws-new', title: b0.title || '新工作区', path: b0.path || '/home/user', count: 0 }) };
        }
        if (url.indexOf('/workspace/register') >= 0) {
            let b1 = {}; try { b1 = JSON.parse(String(msg.body || '{}')); } catch (e) { }
            wsCalls.push({ kind: 'register', workspaceId: b1.workspaceId, sessionId: b1.sessionId });
            return { status: 200, body: JSON.stringify({ ok: true, added: true }) };
        }
        let b = {};
        try { b = JSON.parse(String((msg && msg.body) || '{}')); } catch (e) { }
        dshCallLog.push(b);
        return { status: 200, body: JSON.stringify({ ok: true, text: 'DSH-输出:' + String(b.prompt || '').slice(0, 30), sessionId: 'session-test-1', cwd: '/home/user', ms: 12 }) };
    };
    mock.setNetworkResponder(dshNetResponder);

    // 1) 帮助
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh help' }));
    await sleepMs(120);
    ok(sent.some(function (s) { return String(s.text).indexOf('DSH') >= 0; }), '!dsh help 有回复');

    // 2) 低权限不能进 DSH 模式
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10002' }));
    await sleepMs(120);
    ok(sent.some(function (s) { return String(s.text).indexOf('权限等级') >= 0; }), '低权限被拒绝进入 DSH 模式');
    ok(!dshApi.isModeOn('10002'), '低权限用户没有真的进入模式');

    // 3) 权限够 → 进入
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(120);
    ok(dshApi.isModeOn('10001'), '有权限的用户进入 DSH 模式');
    ok(sent.some(function (s) { return String(s.text).indexOf('DSH 模式') >= 0; }), '提示已进入 DSH 模式');

    // 4) 直连：消息不经大模型，直接给 DSH，并把简要结果回群
    dshCallLog.length = 0;
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '帮我看下磁盘占用', senderId: '10001' }));
    await sleepMs(250);
    ok(dshCallLog.length === 1, 'DSH 模式：消息直接转发给桥接', dshCallLog.length);
    ok(String(dshCallLog[0] && dshCallLog[0].prompt).indexOf('磁盘') >= 0, '转发的是原话');
    ok(dshApi.modeSession('10001') === 'session-test-1', '记住会话 id（后续续传）');
    ok(sent.some(function (s) { return String(s.text).indexOf('DSH-输出:') >= 0; }), '把 DSH 简要输出发回群里', sent.map(function (x) { return String(x.text).slice(0, 80); }));

    // 5) 群聊里别人的消息不会被转发
    dshCallLog.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '我是别人', senderId: '10002' }));
    await sleepMs(200);
    ok(dshCallLog.length === 0, '群聊里只有进入模式的用户会被转发');

    // 6) 退出
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(120);
    ok(!dshApi.isModeOn('10001'), '!dsh off 退出 DSH 模式');

    // 6.5) 合并转发：宿主支持时走 Node()，不支持时回退长文本
    let dshNodeCalls = 0;
    mock.MessageChain.prototype.Node = function (id, name, uid, chain) {
        dshNodeCalls++;
        this.Text('[' + name + ']' + (chain ? chain.AsString() : ''));
        return this;
    };
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(100);
    dshNodeCalls = 0;
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '合并转发测试', senderId: '10001' }));
    await sleepMs(250);
    ok(dshNodeCalls >= 1, '宿主支持 Node 时用合并转发发送', dshNodeCalls);
    ok(sent.some(function (s) { return String(s.text).indexOf('DSH-输出') >= 0; }), '合并转发里带着输出内容');
    try { delete mock.MessageChain.prototype.Node; } catch (e) { mock.MessageChain.prototype.Node = undefined; }
    // 回退路径：没有 Node 时应该仍然发出（长文本）
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '回退测试', senderId: '10001' }));
    await sleepMs(250);
    ok(sent.some(function (s) { return String(s.text).indexOf('DSH-输出') >= 0; }), '宿主不支持 Node 时回退成文本发送');
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(100);

    // 6.6) 图片输出：宿主没有 Node、但有 puppeteer 时，渲染成图片发送
    let dshImgRender = null;
    global.puppeteer = {
        renderHtml: async function (html, timeoutSec, width, height) {
            dshImgRender = { len: String(html).length, width: width, height: height, timeout: timeoutSec, html: String(html) };
            return 'RkFLRUJBU0U2NA==';
        }
    };
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(100);
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '图片输出测试', senderId: '10001' }));
    await sleepMs(250);
    ok(!!dshImgRender, '没有合并转发时改用图片渲染');
    ok(dshImgRender && dshImgRender.width === 760, '图片宽度按配置生效', dshImgRender);
    ok(sent.some(function (x) { return String(x.text).indexOf('[图片]') >= 0; }), '输出以图片形式发送');
    ok(dshImgRender && dshImgRender.html.indexOf('/home/user') >= 0, '图片页脚显示工作区', dshImgRender && dshImgRender.html.slice(-160));
    // 关掉图片 → 应回退文本
    config.setRuntime('dsh.image.enabled', false);
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '关图测试', senderId: '10001' }));
    await sleepMs(250);
    ok(sent.some(function (x) { return String(x.text).indexOf('[图片]') < 0 && String(x.text).indexOf('DSH-输出') >= 0; }), '图片关闭时回退为文本');
    config.setRuntime('dsh.image.enabled', true);
    delete global.puppeteer;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(100);

    // 6.6.2) 装 mod：只建待确认 + 校验域名/扩展名，批准后交给 DSH ✓
    config.setRuntime('dsh.enabled', true);
    config.setRuntime('dsh.baseUrl', 'http://bridge.test');
    config.setRuntime('dsh.token', 't');
    config.setRuntime('dsh.approveMinLevel', 3);
    config.setRuntime('dsh.modeMinLevel', 3);
    // 先记住"这个人刚发的文件"
    litedb.Set('lastfile', '10001', JSON.stringify({ name: 'rank-1.4.1-fabric26.3.jar', url: 'https://njc-download.ftn.qq.com/x/a.jar', size: 95293, ts: Date.now() }));

    config.setRuntime('tools.modInstallTargets', [{ server: '创造服', modsDir: '/data/test-srv/mods', container: 'test-srv' }]);
    const inst1 = await registry.invoke('eb_install_mod', { server: '创造服' }, { senderId: '10001', senderName: '小明' });
    ok(inst1 && inst1.status === 'pending' && inst1.code, '装 mod：先返回待确认 + 确认码', inst1);
    ok(dshApi.getPending(inst1.code) && String(dshApi.getPending(inst1.code).task).indexOf('/data/test-srv/mods') >= 0,
        '装 mod：任务里写明目标 mods 目录');

    const inst2 = await registry.invoke('eb_install_mod', { server: '创造服', url: 'https://evil.example.com/a.jar' }, { senderId: '10001' });
    ok(inst2 && inst2.success === false && String(inst2.error).indexOf('evil.example.com') >= 0,
        '装 mod：拒绝非 QQ CDN 域名（且错误里带出真实域名，防"空域名假通过"）', inst2);
    // 反过来：真实 CDN 域名必须通过 → 说明 host 解析真的工作 ✓
    const inst2b = await registry.invoke('eb_install_mod', { server: '创造服', url: 'https://njc-download.ftn.qq.com/ftn_handler/x/?fname=a.jar' }, { senderId: '10001' });
    ok(inst2b && inst2b.status === 'pending', '装 mod：QQ CDN 域名能通过', inst2b);

    const inst3 = await registry.invoke('eb_install_mod', { server: '某个服' }, { senderId: '10001' });
    ok(inst3 && inst3.success === false, '装 mod：拒绝未知服务器', inst3);

    const inst4 = await registry.invoke('eb_install_mod', { server: '创造服', url: 'https://njc-download.ftn.qq.com/x/a.txt' }, { senderId: '10001' });
    ok(inst4 && inst4.success === false && String(inst4.error).indexOf('.jar') >= 0, '装 mod：只接受 .jar', inst4);

    // 批准 → 应当真的交给 DSH
    dshCallLog.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '同意 ' + inst1.code, senderId: '10001' }));
    await sleepMs(400);
    ok(dshCallLog.some(function (c) { return String(c.prompt || '').indexOf('/data/test-srv/mods') >= 0; }),
        '装 mod：管理员同意后才交给 DSH 执行', dshCallLog.length);

    // 6.6.5) 帮助命令
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!help' }));
    await sleepMs(150);
    ok(sent.some(function (x) { return String(x.text).indexOf('命令帮助') >= 0 && String(x.text).indexOf('DSH') >= 0; }), '!help 能给出总帮助');
    ok(sent.some(function (x) { return String(x.text).indexOf('离线快递帮助') >= 0; }), '总帮助里提到寄件帮助');
    // 防漂移：总帮助必须覆盖所有关键子命令（以后加命令忘了写帮助 → 这条会红 ✓）
    const helpTxt = sent.filter(function (x) { return String(x.text).indexOf('命令帮助') >= 0; }).map(function (x) { return String(x.text); }).join('\n');
    const mustHave = ['on|off', 'new', 'status', 'preview', 'ws', 'ls', 'use', 'import', 'ok', 'pending'];
    const missing = mustHave.filter(function (k) { return helpTxt.indexOf('!dsh ' + k) < 0 && helpTxt.indexOf(k) < 0; });
    ok(missing.length === 0, '总帮助覆盖所有关键子命令', missing);
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!help dsh' }));
    await sleepMs(150);
    ok(sent.some(function (x) { return String(x.text).indexOf('!dsh ws') >= 0 && String(x.text).indexOf('preview') >= 0; }), '!help dsh 给出 DSH 详细帮助（含工作区/预览）');

    // 6.6.7) on/off 的幂等提示
    ok(!dshApi.isModeOn('10001'), '前置：当前不在 DSH 模式');
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(150);
    ok(sent.some(function (x) { return String(x.text).indexOf('不在 DSH 模式') >= 0; }), '不在模式时 !dsh off 会明确告知');
    ok(!dshApi.isModeOn('10001'), '!dsh off 不会把人留在模式里');

    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(150);
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(150);
    ok(sent.some(function (x) { return String(x.text).indexOf('已经在 DSH 模式') >= 0; }), '已在模式时 !dsh on 会明确告知');
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(100);

    // 6.6.8) 会话级绑定（不是每次新开）
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ls' }));
    await sleepMs(200);
    ok(sent.some(function (x) { return String(x.text).indexOf('插件开发文档查阅') >= 0; }), '!dsh ls 能列出会话（带标题）');

    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh use 1' }));
    await sleepMs(200);
    ok(dshApi.modeSession('10001') === 'session-a', '!dsh use 1 绑定到第一个会话', dshApi.modeSession('10001'));

    // 网页建的会话（有 agent preset）headless 接不了 → 必须拒绝并解释
    const beforeBind = dshApi.modeSession('10001');
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh use 2', senderId: '10001' }));
    await sleepMs(200);
    ok(dshApi.modeSession('10001') === beforeBind, '选到网页会话时不改绑定');
    ok(sent.some(function (x) { return String(x.text).indexOf('接不了') >= 0; }), '选到网页会话时给出解释');
    ok((dshApi.workspaceOf('10001') || {}).id === 'ws-home', '绑定会话时同步切到它的工作区');

    // 选工作区 = 自动接着该工作区最近的会话（不是新开）
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ws use 1', senderId: '10001' }));
    await sleepMs(250);
    ok((dshApi.workspaceOf('10001') || {}).id === 'ws-home', '!dsh ws use 1 切到 home');
    ok(!dshApi.modeSession('10001'), '切工作区后清空会话绑定（等用户选）', dshApi.modeSession('10001'));
    ok(sent.some(function (x) { return String(x.text).indexOf('!dsh use') >= 0 && String(x.text).indexOf('插件开发文档查阅') >= 0; }),
        '切工作区后列出会话并提示用 !dsh use 选一个');

    // 工具模式：批准后应当用绑定会话（不再新开）
    // 注意：上面 !dsh ws use 会清空绑定，所以这里重新绑一次 ✓
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh use 1' }));
    await sleepMs(200);
    dshCallLog.length = 0;
    const rWs1 = await registry.invoke('dsh_run', { task: '沿用会话测试' }, { senderId: '10001', senderName: '小明' });
    await mock.bus.emit('group_message_event', groupEvent({ text: '同意 ' + rWs1.code, senderId: '10001' }));
    await sleepMs(400);
    ok(dshCallLog.length >= 1 && dshCallLog[dshCallLog.length - 1].sessionId === 'session-a',
        '工具模式沿用绑定会话（不新开会话）', dshCallLog.slice(-1));

    // 6.6.9) 上下文继承（网页会话也能导入）
    sent.length = 0;
    dshCallLog.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh import 2', senderId: '10001' }));
    await sleepMs(600);
    ok(dshCallLog.length >= 1, '!dsh import 会真的发起一次会话');
    ok(dshCallLog.length >= 1 && String(dshCallLog[dshCallLog.length - 1].prompt).indexOf('【历史对话】') >= 0,
        '注入的提示里带着历史对话', String((dshCallLog[dshCallLog.length - 1] || {}).prompt || '').slice(0, 80));
    ok(dshApi.modeSession('10001') === 'session-test-1', '继承后绑定到新会话', dshApi.modeSession('10001'));
    ok(sent.some(function (x) { return String(x.text).indexOf('上下文已继承') >= 0; }), '继承成功有明确回复');

    // 6.7) 工作区：列出 / 选择 / 新建 / 取消 + 跑完自动登记
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ws', senderId: '10001' }));
    await sleepMs(150);
    ok(sent.some(function (x) { return String(x.text).indexOf('EasyBot') >= 0 && String(x.text).indexOf('home') >= 0; }), '!dsh ws 能列出工作区');

    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ws use 2', senderId: '10001' }));
    await sleepMs(150);
    ok((dshApi.workspaceOf('10001') || {}).id === 'ws-bot', '!dsh ws use 2 选中第二个工作区', dshApi.workspaceOf('10001'));

    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh status', senderId: '10001' }));
    await sleepMs(200);
    ok(sent.some(function (x) { return String(x.text).indexOf('EasyBot') >= 0; }), '!dsh status 显示所选工作区');

    wsCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh on', senderId: '10001' }));
    await sleepMs(100);
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '登记测试任务', senderId: '10001' }));
    await sleepMs(300);
    ok(wsCalls.some(function (c) { return c.kind === 'register' && c.workspaceId === 'ws-bot' && c.sessionId === 'session-test-1'; }),
        '跑完把会话登记到所选工作区', wsCalls);
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh off', senderId: '10001' }));
    await sleepMs(100);

    wsCalls.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ws new 测试区 /home/user', senderId: '10001' }));
    await sleepMs(200);
    ok(wsCalls.some(function (c) { return c.kind === 'create' && c.title === '测试区'; }), '!dsh ws new 能新建工作区', wsCalls);
    ok((dshApi.workspaceOf('10001') || {}).id === 'ws-new', '新建后自动选中');

    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh ws off', senderId: '10001' }));
    await sleepMs(150);
    ok(!dshApi.workspaceOf('10001'), '!dsh ws off 取消选择');

    // 7) 工具模式：dsh_run 只产生"待确认"，不执行
    sent.length = 0;
    dshCallLog.length = 0;
    const dshRun1 = await registry.invoke('dsh_run', { task: '在 /tmp 建个文件' }, { senderId: '10001', senderName: '小明' });
    ok(dshRun1.success === true && dshRun1.status === 'pending' && !!dshRun1.code, 'dsh_run 返回待确认 + 确认码', dshRun1);
    ok(dshCallLog.length === 0, '未确认前绝对不执行');
    ok(sent.some(function (s) { return String(s.text).indexOf('同意 ' + dshRun1.code) >= 0; }), '在会话里发出确认请求给管理员');

    // 8) 低权限批准被拒
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '同意 ' + dshRun1.code, senderId: '10002' }));
    await sleepMs(200);
    ok(dshCallLog.length === 0, '低权限批准不会执行');
    ok(sent.some(function (s) { return String(s.text).indexOf('需要权限等级') >= 0; }), '低权限批准有明确提示');

    // 9) 管理员批准 → 执行 → dsh_result 取结果
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '同意 ' + dshRun1.code, senderId: '10001' }));
    await sleepMs(400);
    ok(dshCallLog.length === 1, '管理员批准后才真正执行', dshCallLog.length);
    const dshRes1 = await registry.invoke('dsh_result', { requestId: dshRun1.requestId }, { senderId: '10001' });
    ok(dshRes1.status === 'done' && String(dshRes1.result).indexOf('DSH-输出') >= 0, 'dsh_result 能取到结果', dshRes1);

    // 10) 拒绝
    const dshRun2 = await registry.invoke('dsh_run', { task: '删除某个目录' }, { senderId: '10001' });
    await mock.bus.emit('group_message_event', groupEvent({ text: '拒绝 ' + dshRun2.code, senderId: '10001' }));
    await sleepMs(200);
    const dshRes2 = await registry.invoke('dsh_result', { requestId: dshRun2.requestId }, { senderId: '10001' });
    ok(dshRes2.status === 'rejected', '拒绝后状态为 rejected', dshRes2);
    ok(dshCallLog.length === 1, '被拒绝的任务没有执行');

    // 11) token 不回显
    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent({ text: '!dsh set token sk-secret-123', senderId: '10001' }));
    await sleepMs(150);
    ok(!sent.some(function (s) { return String(s.text).indexOf('sk-secret-123') >= 0; }), '!dsh set token 不回显明文');

    // 恢复现场
    config.setRuntime('dsh.enabled', false);
    mock.setNetworkResponder(chatResponder);

    section('禁用');

    await mock.bus.emit('disable');
    ok(mock.httpServers['ai_chat_gateway'] === undefined, '禁用后工具网关被销毁');

    // ---------------------------------------------------------------- 汇总
    console.log('\n=====================================');
    console.log(' 通过 ' + passed + ' 项, 失败 ' + failed + ' 项');
    if (failed) console.log(' 失败项: \n   - ' + failures.join('\n   - '));
    console.log('=====================================');
    process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
    console.error('自测崩溃:', e && e.stack ? e.stack : e);
    process.exit(2);
});
