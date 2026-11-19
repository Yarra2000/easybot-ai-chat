'use strict';

/**
 * 把多文件源码打包成「单文件插件」。
 *
 * 为什么需要它:
 *   在真实的 EasyBot (miuxue/easybot:dev-full) 上实测发现, 它的 CommonJS
 *   加载器会把相对路径解析成 `app/appdata/plugins/<id>/...`(丢了开头斜杠),
 *   导致 require('./lib/util.js') 一律失败。官方文档承诺的 CommonJS 在这个
 *   build 上不可用, 所以发布版采用 EasyBot 原生支持的单文件插件形式,
 *   内部用一个极小的模块表代替 require。
 *
 * 用法:
 *   node dev/build-bundle.js                       # 生成 ../ai_chat.js
 *   node dev/build-bundle.js --overlay cfg.json    # 打包时注入默认配置(用于测试部署)
 *   node dev/build-bundle.js --out /tmp/x.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = 'main.js';

function parseArgs(argv) {
    const out = { overlay: null, out: path.join(ROOT, 'ai_chat.js') };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--overlay') out.overlay = argv[++i];
        else if (argv[i] === '--out') out.out = argv[++i];
    }
    return out;
}

/** 收集需要打包的模块: main.js + lib/**.js */
function collect() {
    const files = [];
    function walk(dir) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
            if (e.name.startsWith('.')) return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); return; }
            if (e.name.endsWith('.js')) files.push(p);
        });
    }
    files.push(path.join(ROOT, ENTRY));
    walk(path.join(ROOT, 'lib'));
    return files.map(function (p) {
        return { key: path.relative(ROOT, p).split(path.sep).join('/'), file: p };
    }).sort(function (a, b) { return a.key < b.key ? -1 : 1; });
}

function buildStamp() {
    try {
        if (process.env.SOURCE_DATE_EPOCH) {
            return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
        }
    } catch (e) { }
    try {
        const t = require('child_process').execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).trim();
        if (t) return new Date(Number(t) * 1000).toISOString();
    } catch (e) { }
    return '1970-01-01T00:00:00.000Z';
}

function build(opts) {
    const modules = collect();
    let overlay = null;
    if (opts.overlay) {
        overlay = JSON.parse(fs.readFileSync(opts.overlay, 'utf8'));
    }

    const out = [];
    out.push('/*');
    out.push(' * EasyBot AI 对话助手 - 单文件构建产物');
    out.push(' * 由 dev/build-bundle.js 自动生成, 请勿直接修改本文件。');
    out.push(' * 源码在 main.js 与 lib/ 下, 修改后重新执行: node dev/build-bundle.js');
    // ★ 构建时间必须【可复现】: 否则同一个提交每次打出来的包 md5 都不一样, 没法核对 ✗
    //   优先级: 环境变量 SOURCE_DATE_EPOCH(标准做法) > git 最后一次提交时间 > 固定串
    out.push(' * 生成时间: ' + buildStamp());
    out.push(' * 模块数: ' + modules.length);
    if (overlay) out.push(' * 注意: 本产物在打包时注入了默认配置覆盖(仅测试用)');
    out.push(' */');
    out.push('');
    out.push('(function () {');
    out.push("'use strict';");
    out.push('');
    out.push('var __modules = {};');
    out.push('var __cache = {};');
    out.push('');

    modules.forEach(function (m) {
        let code = fs.readFileSync(m.file, 'utf8');
        if (overlay && m.key === 'lib/config.js') {
            code += '\n\n// ---- 打包时注入的默认配置覆盖 ----\n' +
                'deepMerge(DEFAULT_CONFIG, ' + JSON.stringify(overlay, null, 4) + ');\n';
        }
        out.push('__modules[' + JSON.stringify(m.key) + '] = function (module, exports, require) {');
        out.push(code);
        out.push('};');
        out.push('');
    });

    out.push('function __resolve(fromKey, spec) {');
    out.push('    var baseDir = fromKey.split("/").slice(0, -1).join("/");');
    out.push('    var parts = (baseDir ? baseDir.split("/") : []).concat(String(spec).split("/"));');
    out.push('    var stack = [];');
    out.push('    for (var i = 0; i < parts.length; i++) {');
    out.push('        var seg = parts[i];');
    out.push('        if (seg === "" || seg === ".") continue;');
    out.push('        if (seg === "..") { stack.pop(); continue; }');
    out.push('        stack.push(seg);');
    out.push('    }');
    out.push('    var key = stack.join("/");');
    out.push('    if (!/\\.js$/.test(key)) key += ".js";');
    out.push('    return key;');
    out.push('}');
    out.push('');
    out.push('function __requireFrom(fromKey, spec) {');
    out.push('    var key = __resolve(fromKey, spec);');
    out.push('    if (__cache[key]) return __cache[key].exports;');
    out.push('    var factory = __modules[key];');
    out.push('    if (!factory) {');
    out.push('        throw new Error("[ai-chat] 单文件构建内找不到模块: " + spec + " (from " + fromKey + ", 解析为 " + key + ")");');
    out.push('    }');
    out.push('    var module = { exports: {} };');
    out.push('    __cache[key] = module;');
    out.push('    factory(module, module.exports, function (s) { return __requireFrom(key, s); });');
    out.push('    return module.exports;');
    out.push('}');
    out.push('');
    out.push('__requireFrom("", "./' + ENTRY + '");');
    out.push('');
    out.push('})();');
    out.push('');

    fs.writeFileSync(opts.out, out.join('\n'), 'utf8');
    return { out: opts.out, modules: modules.length, bytes: fs.statSync(opts.out).size };
}

if (require.main === module) {
    const opts = parseArgs(process.argv);
    const r = build(opts);
    console.log('已生成: ' + r.out);
    console.log('模块数: ' + r.modules + ', 大小: ' + (r.bytes / 1024).toFixed(1) + ' KB');
}

module.exports = { build: build };
