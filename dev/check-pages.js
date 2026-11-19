// 发布前必须过: 在假 DOM 里真跑一遍 WebUI 页面脚本, 调用每个 load* 函数。
//
// 为什么需要: 内联 JS 语法检查通不过运行期错误。已经踩过两次 ——
//   ① saveReply() 引用不存在的元素 -> 点保存静默失败
//   ② loadReply() 对字符串调用 .join() -> 整个标签页空白
// 语法都合法, 但一运行就炸。这个检查把"页面能不能真的渲染出来"变成门禁。
global.logger = { info: function () { }, warning: function () { }, error: function () { } };
const mock = require('./mock-easybot.js');
mock.install();
const util = require('../lib/util.js');
const config = require('../lib/config.js');
require('../main.js');   // 让插件注册菜单/动作

function makeEl(id) {
    const el = {
        id: id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
        style: {}, dataset: {}, children: [],
        classList: { add: function () { }, remove: function () { }, contains: function () { return false; }, toggle: function () { } },
        addEventListener: function () { }, removeEventListener: function () { },
        appendChild: function () { }, removeChild: function () { }, setAttribute: function () { },
        querySelector: function () { return null; }, querySelectorAll: function () { return []; },
        focus: function () { }, blur: function () { }, click: function () { }
    };
    return el;
}

async function main() {
    const webui = require('../lib/webui.js');
    let onAction = null, pageHtml = null;
    await mock.bus.emit('menu_ready', {
        registerGroup: function () { return { id: 'g' }; },
        register: function (id, path, label, icon, onA, onGet) { onAction = onA; pageHtml = onGet; return { id: id }; }
    });
    if (!onAction) throw new Error('拿不到菜单动作处理器');
    const html = pageHtml();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('页面没有内联脚本');

    const els = {};
    const doc = {
        getElementById: function (id) { if (!els[id]) els[id] = makeEl(id); return els[id]; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        createElement: makeEl,
        addEventListener: function () { },
        body: makeEl('body')
    };
    // 页面里的 call() 实际调的是 EasyBot 注入的 window.webuikit.action(method, params)
    const callFn = function (method, params) {
        return Promise.resolve(onAction({ method: method, parameters: params || {} }));
    };
    const fakeWindow = {
        addEventListener: function () { },
        location: {},
        webuikit: { action: callFn }
    };

    // 在沙箱里执行页面脚本, 并把所有 load* 函数取出来
    const factory = new Function('document', 'window', 'call', 'setTimeout', 'console',
        m[1] + '\n;return {' +
        ['loadDash', 'loadTools', 'loadMem', 'loadPersona', 'loadReply', 'loadPerm', 'loadKb', 'loadLlm', 'loadTest', 'saveReply', 'applyPreset']
            .map(function (n) { return n + ': (typeof ' + n + ' === "function") ? ' + n + ' : null'; }).join(', ') +
        '};');
    const api = factory(doc, fakeWindow, callFn, setTimeout, console);

    const tabs = { dash: 'loadDash', tools: 'loadTools', mem: 'loadMem', persona: 'loadPersona', reply: 'loadReply', perm: 'loadPerm', kb: 'loadKb', llm: 'loadLlm', test: 'loadTest' };
    const fails = [];

    for (const tab of Object.keys(tabs)) {
        const fnName = tabs[tab];
        const fn = api[fnName];
        if (typeof fn !== 'function') { fails.push(fnName + ' 不存在'); continue; }
        try { await fn(); } catch (e) { fails.push(fnName + ' 抛异常: ' + ((e && e.message) || e)); continue; }
        await new Promise(function (r) { setTimeout(r, 30); });
        const el = els['tab-' + tab];
        const out = el ? String(el.innerHTML || '') : '';
        if (!out.trim()) { fails.push(tab + ' 渲染为空(页面会显示空白)'); continue; }
        if (out.indexOf('加载出错') >= 0) { fails.push(tab + ' 渲染出错: ' + out.slice(0, 160)); continue; }
        console.log('  ✅ ' + tab + ' 渲染正常 (' + out.length + ' 字节)');
    }

    // 关键内容断言(防字段漏渲染)
    const reply = String((els['tab-reply'] || {}).innerHTML || '');
    ['r_manualPrefix', 'r_manualAction', 'r_stripRegex', 'r_splitNl', 'saveReply()'].forEach(function (k) {
        if (reply.indexOf(k) < 0) fails.push('回复逻辑页缺少 ' + k);
    });
    const llm = String((els['tab-llm'] || {}).innerHTML || '');
    ['lm_url', 'lm_model', 'lm_key', 'lm_relay'].forEach(function (k) {
        if (llm.indexOf(k) < 0) fails.push('模型页缺少 ' + k);
    });

    if (fails.length) {
        console.error('\n❌ 页面运行检查失败:');
        fails.forEach(function (f) { console.error('   - ' + f); });
        process.exit(1);
    }
    console.log('✅ 页面运行检查通过 (9 个标签页在假 DOM 里都能渲染出来)');
}
main().catch(function (e) { console.error('❌ 页面运行检查崩溃: ' + ((e && e.stack) || e)); process.exit(1); });
