// 发布前必须过: WebUI 内联 JS 语法 + 标签配对
global.logger = { info: function () { }, warning: function () { }, error: function () { } };
const h = require('../lib/webui.js').pageHtml();
const m = h.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('❌ 页面里找不到内联脚本'); process.exit(1); }
try { new Function(m[1]); } catch (e) { console.error('❌ 内联 JS 语法错误: ' + e.message); process.exit(1); }
const a = (h.match(/<div/g) || []).length, b = (h.match(/<\/div>/g) || []).length;
if (a !== b) { console.error('❌ <div> 不配对: ' + a + ' vs ' + b); process.exit(1); }

// ---------------------------------------------------------------- 元素 id 一致性
// 血的教训: saveReply 里引用了 4 个页面从没渲染的 id, 点保存时 $("x").value 抛异常,
// 整个函数中断 —— 表现为"点保存没反应", 排查了半天。这里做成静态门禁。
const js = m[1];

// 渲染出来的 id: id=xxx / id="xxx" / id=\"xxx\" (源码里是转义过的双引号)
const rendered = new Set();
let mm;
const reRendered = /id=\\?"?([A-Za-z_][\w-]*)/g;
while ((mm = reRendered.exec(h)) !== null) rendered.add(mm[1]);   // 在整页 HTML 里找(含骨架)

// 被引用的 id: $("x") / getElementById("x")
const referenced = new Set();
const reRef = /(?:\$|getElementById)\(\s*"([A-Za-z_][\w-]*)"\s*\)/g;
while ((mm = reRef.exec(js)) !== null) referenced.add(mm[1]);

// 白名单: EasyBot 外壳里自带的元素 / 由其它脚本动态生成的
const allow = new Set(['root', 'easybot-loading']);

const dangling = Array.from(referenced).filter(function (id) {
    return !rendered.has(id) && !allow.has(id);
});
if (dangling.length) {
    console.error('❌ 引用了没渲染的元素 id (点击会静默失败): ' + dangling.join(', '));
    process.exit(1);
}
// 反向也提示一下(渲染了但没人用, 只是提示)
const unused = Array.from(rendered).filter(function (id) { return !referenced.has(id); });
console.log('✅ WebUI 检查通过 (内联 JS 语法 OK, div 配对 ' + a + '/' + b +
    ', 元素 id ' + rendered.size + ' 个全部有引用' + (unused.length ? ', 未被引用 ' + unused.length + ' 个' : '') + ')');
