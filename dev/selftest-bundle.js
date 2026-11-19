'use strict';

/**
 * 单文件构建产物 (ai_chat.js) 的冒烟测试。
 *
 * 为什么单独测: 真实 EasyBot 的 require 不可用, 发布版是打包后的单文件,
 * 所以必须单独验证打包产物本身能跑通 (加载 → 启用 → 群消息 → 工具调用 → 回复)。
 *
 * 运行: node dev/selftest-bundle.js
 */

const fs = require('fs');
const path = require('path');
const mock = require('./mock-easybot.js');
mock.install();

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond) { passed++; console.log('  ✅ ' + label); }
    else { failed++; failures.push(label); console.log('  ❌ ' + label + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
}

const BUNDLE = path.resolve(__dirname, '..', 'ai_chat.js');

mock.configValues['main'] = {
    apiKey: 'sk-test', baseUrl: 'https://example.com/v1', model: 'm',
    'behavior.cooldownSec': 0,
    'behavior.maxRepliesPerMinute': 999,
    'behavior.continuationWindowSec': 0,
    'humanize.typingBaseMs': 0, 'humanize.typingPerCharMs': 0, 'humanize.typingJitterMs': 0,
    'humanize.segmentDelayBaseMs': 0, 'humanize.segmentDelayPerCharMs': 0, 'humanize.segmentDelayJitterMs': 0,
    'humanize.quoteChance': 0, 'humanize.atChance': 0, 'humanize.emojiChance': 0,
    'memory.autoSummaryEvery': 0,
    'tools.discover.enabled': false
};

let calls = 0;
mock.setNetworkResponder(async function (msg) {
    const body = JSON.parse(msg.body || '{}');
    calls++;
    const hasTool = (body.messages || []).some(function (m) { return m.role === 'tool'; });
    if (!hasTool) {
        return {
            status: 200, data: {
                choices: [{
                    message: {
                        role: 'assistant', content: '',
                        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'eb_list_servers', arguments: '{}' } }]
                    }, finish_reason: 'tool_calls'
                }]
            }
        };
    }
    return { status: 200, data: { choices: [{ message: { role: 'assistant', content: '打包版本工作正常~' }, finish_reason: 'stop' }] } };
});

const sent = [];
function groupEvent(text, at) {
    const selfId = '99999';
    const segs = [];
    if (at) segs.push(new mock.AtSegment(selfId));
    segs.push(new mock.TextSegment(text));
    return {
        SelfId: selfId, SenderId: '10001', PeerId: '123456', MessageId: 'm1',
        SenderName: '小明', SenderRole: 'member',
        RawMessage: (at ? '[CQ:at,qq=' + selfId + ']' : '') + text,
        Messages: segs, Chain: new mock.MessageChain().Text(text),
        AdapterContext: {
            SendGroupMessageAsync: async function (s, p, chain) { sent.push(chain.AsString()); return 'bot_1'; },
            SendDirectMessageAsync: async function (s, p, chain) { sent.push(chain.AsString()); return 'bot_2'; }
        },
        Context: { Reply: async function (chain) { sent.push(chain.AsString()); return 'r'; } }
    };
}

async function main() {
    console.log('=== 单文件构建产物冒烟测试 ===');
    ok(fs.existsSync(BUNDLE), 'ai_chat.js 存在');
    const src = fs.readFileSync(BUNDLE, 'utf8');
    ok(src.indexOf('__modules') > 0, '产物包含内置模块表');
    ok(src.indexOf('function __requireFrom') > 0, '产物自带模块加载器(不依赖宿主 require)');
    ok(src.indexOf('EasyBot AI 对话助手 - 单文件构建产物') > 0, '产物带构建说明头');

    // 直接执行打包产物 (它会用 mock 的全局对象)
    require(BUNDLE);

    ok(mock.bus.count('group_message_event') === 1, '打包版注册了群消息事件');
    ok(mock.bus.count('enable') === 1, '打包版注册了 enable 事件');

    await mock.bus.emit('enable');
    ok(mock.httpServers['ai_chat_gateway'] && mock.httpServers['ai_chat_gateway'].running, '打包版启动了工具网关');
    ok(mock.formDefinitions.length === 1, '打包版注册了配置表单');

    // 注意: 不能直接 require('../lib/tools/registry.js') —— 那是源码模块的另一份实例。
    // 通过打包版自己的 HTTP 网关来查看它内部的工具表。
    const toolsRes = await mock.callRoute('ai_chat_gateway', 'GET', '/tools', { url: '/tools', method: 'GET', headers: {} });
    const toolsBody = JSON.parse(toolsRes.body || '{}');
    ok((toolsBody.tools || []).length >= 13, '打包版内置工具已注册 (' + (toolsBody.tools || []).length + ')');
    ok((toolsBody.tools || []).some(function (t) { return t.name === 'eb_list_servers'; }), '打包版包含 eb_list_servers');

    sent.length = 0;
    await mock.bus.emit('group_message_event', groupEvent('ai 有哪些服务器', true));
    await new Promise(function (r) { setTimeout(r, 300); });
    ok(sent.length >= 1 && sent.join('').indexOf('打包版本工作正常') >= 0, '打包版完成一次完整对话+工具调用', sent);
    ok(calls >= 2, '打包版发生了多轮模型调用 (' + calls + ')');

    console.log('\n通过 ' + passed + ' 项, 失败 ' + failed + ' 项');
    if (failed) console.log('失败: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
}

main().catch(function (e) {
    console.error('冒烟测试崩溃:', e && e.stack ? e.stack : e);
    process.exit(2);
});
