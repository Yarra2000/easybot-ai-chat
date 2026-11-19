'use strict';

/**
 * 生成「可发布」的市场包: dist/<plugin>-<version>.zip
 *
 * ★ 为什么必须有这个脚本 —— 实测踩过一次真实发布事故 ✗:
 *   1) ai_chat.js 是【带密钥】的构建产物(部署用), 它在 .gitignore 里;
 *      直接 `git ls-files` 打包 -> 包里【没有入口文件】-> 上传到资源市场后装不上 ✗✗
 *   2) 反过来, 如果把带密钥的那份打进包里 -> 密钥直接泄漏 ✗✗
 *   => 发布包必须用【不带 overlay 重新构建的干净产物】当入口, 并且自动校验 ✓
 *
 * 用法:
 *   node dev/make-release.js                 # 正式发布包(不含 dev/、CHANGELOG)
 *   node dev/make-release.js --dev           # ★ 开发包: 连 dev/(构建/自测/mock 宿主/gate/探针插件)
 *                                            #   和 CHANGELOG 一起打包, 方便拿过去直接改代码
 *   node dev/make-release.js --keep-bundle   # 顺便把干净产物留在 dist/ 里(便于排查)
 *
 * 它会做这些校验, 任何一项不过就【报错退出】(不会留下坏包):
 *   [1] manifest.json 在 zip 根部(不能有文件夹前缀, 市场靠它自动识别)
 *   [2] manifest.entry 指定的入口文件确实在包里            <- 上次就是栽在这
 *   [3] 包里没有任何真实密钥(sk- / Bearer 长串 / 常见 token 形态)
 *   [4] 没有 dev/ CHANGELOG.md .gitignore 等不该分发的东西
 *   [5] manifest 能解析、必填字段齐全
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * 真实密钥的形态(占位符如 sk-xxx 不算) —— 只在文本文件里查。
 * ★★ 绝对不要在这里写具体的令牌字面量 ✗ —— 本脚本是【公开仓库】的一部分,
 *    写进去等于把令牌一起发布了(实测踩过: 把服务器令牌当"特征串"写在这, 结果它被提交进仓库 ✗)。
 *    维护者自己有额外要拦的串, 用环境变量传: EXTRA_SECRET_PATTERNS="规则1;规则2" ✓
 */
const REAL_SECRET = new RegExp([
    'sk-[A-Za-z0-9_\\-]{20,}',
    'Bearer\\s+[A-Za-z0-9_\\-.]{30,}',
    '[A-Za-z0-9_]{24,}\\.[A-Za-z0-9_]{6,}\\.[A-Za-z0-9_]{20,}'   // 三段式 token
].concat(
    String(process.env.EXTRA_SECRET_PATTERNS || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean)
).join('|'));

/**
 * 不打进包里的东西。
 *   正式包: 排除 dev/(构建脚本/自测/mock 宿主) 和 CHANGELOG —— 使用者不需要 ✓
 *   开发包: 【保留】dev/ 与 CHANGELOG —— 正是拿去改代码、跑自测要用的 ✓
 * 两种包都不含 .gitignore / dist/ / node_modules/ ✓
 */
const EXCLUDE_ALWAYS = ['.gitignore', 'dist/', 'node_modules/'];
const EXCLUDE_RELEASE_ONLY = ['dev/', 'CHANGELOG.md'];

function sh(cmd, args) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
}

function listTracked(dev) {
    const skip = EXCLUDE_ALWAYS.concat(dev ? [] : EXCLUDE_RELEASE_ONLY);
    return sh('git', ['ls-files']).split('\n').map(function (x) { return x.trim(); })
        .filter(Boolean)
        .filter(function (f) { return !skip.some(function (e) { return f === e || f.startsWith(e); }); });
}

function main() {
    const keepBundle = process.argv.indexOf('--keep-bundle') >= 0;
    const isDev = process.argv.indexOf('--dev') >= 0;

    // ---- 1) 干净产物(不带 overlay => 不注入任何密钥) ----
    let entryClean = null;
    const builder = path.join(ROOT, 'dev', 'build-bundle.js');
    if (fs.existsSync(builder)) {
        const tmp = path.join(DIST, '.release-bundle.js');
        fs.mkdirSync(DIST, { recursive: true });
        process.stdout.write('  [1/5] 用干净配置重新构建入口产物 ... ');
        // ★ 固定"构建时间"(用本次提交的时间) -> 同一个提交永远打出同样的包, md5 可核对 ✓
        let stamp = '';
        try { stamp = sh('git', ['log', '-1', '--format=%ct']).trim(); } catch (e) { }
        process.env.SOURCE_DATE_EPOCH = stamp || '0';
        sh('node', ['dev/build-bundle.js', '--out', tmp]);
        entryClean = fs.readFileSync(tmp, 'utf8');
        console.log('OK (' + Math.round(Buffer.byteLength(entryClean, 'utf8') / 1024) + ' KB)');
    } else {
        console.log('  [1/5] 无构建步骤(入口就是源码), 跳过重建');
    }

    // ---- 2) manifest ----
    process.stdout.write('  [2/5] 读 manifest.json ... ');
    const manifestPath = path.join(ROOT, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('缺少 manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = String(manifest.entry || '').replace(/^\.\//, '');
    if (!entry) throw new Error('manifest.json 里没有 entry');
    for (const k of ['name', 'version', 'plugin_id', 'author', 'entry']) {
        if (!manifest[k]) throw new Error('manifest.json 缺少必填字段: ' + k);
    }
    if (!/^[a-z_]+$/.test(manifest.plugin_id)) throw new Error('plugin_id 只能用小写字母和下划线: ' + manifest.plugin_id);
    console.log('OK (' + manifest.name + ' v' + manifest.version + ', entry=' + entry + ')');

    // ---- 3) 组包 ----
    process.stdout.write('  [3/5] 组包 ... ');
    const Zip = require('./zip.js');
    const files = listTracked(isDev);
    const zip = new Zip();
    const textFiles = {};
    files.forEach(function (f) {
        const full = path.join(ROOT, f);
        const buf = fs.readFileSync(full);
        zip.add(f, buf);
        if (/\.(js|json|md|txt|conf|example)$/i.test(f) || f === 'manifest.json') {
            textFiles[f] = buf.toString('utf8');
        }
    });
    // ★ 入口: 用【干净产物】覆盖同名文件(源码里那份可能是带密钥的构建产物, 也可能压根不在 git 里)
    //   ⚠️ 但入口的【文件名】必须和构建产物的文件名一致 ——
    //   上次的发布事故就是没对上: 包里没有 manifest.entry 指向的文件, 上传后装不上 ✗
    if (entryClean !== null) {
        const builtName = 'ai_chat.js';                 // dev/build-bundle.js 的固定输出名
        if (entry !== builtName) {
            throw new Error('manifest.entry(' + entry + ') 和构建产物名(' + builtName + ') 对不上 —— ' +
                '这样打出来的包市场装不上。请改 manifest.json 的 entry, 或改构建输出名');
        }
        zip.add(builtName, Buffer.from(entryClean, 'utf8'));
        textFiles[builtName] = entryClean;
    }
    // ★ 入口必须真的在包里(不能靠"我加过它"来假设 —— 上次就是这么自己骗自己的 ✗)
    if (!zip.names().includes(entry)) {
        throw new Error('入口 ' + entry + ' 不在包里(它既不在 git 里, 也没有构建产物能补上)');
    }
    console.log('OK (' + zip.count() + ' 个文件)');

    // ---- 4) 校验 ----
    process.stdout.write('  [4/5] 校验 ... ');
    const names = zip.names();
    if (names.indexOf('manifest.json') < 0) throw new Error('manifest.json 不在包根部(市场靠它自动识别)');
    if (names.indexOf(entry) < 0) throw new Error('★ manifest.entry 指定的 ' + entry + ' 不在包里 —— 上传后会装不上!');
    if (!isDev && names.some(function (n) { return n.indexOf('dev/') === 0; })) {
        throw new Error('正式包里混进了 dev/');
    }
    if (isDev) {
        // 开发包必须带齐"能改能测"的东西, 否则拿去之后跑不起来 ✗
        const need = ['dev/build-bundle.js', 'dev/selftest.js', 'dev/mock-easybot.js'];
        const miss = need.filter(function (x) { return names.indexOf(x) < 0; });
        if (miss.length) throw new Error('开发包缺少: ' + miss.join(', '));
    }
    const bad = [];
    Object.keys(textFiles).forEach(function (f) {
        const m = REAL_SECRET.exec(textFiles[f]);
        if (m) bad.push(f + ' -> ' + m[0].slice(0, 12) + '…');
    });
    if (bad.length) throw new Error('★ 包里发现真实密钥, 拒绝生成: ' + bad.join('; '));
    console.log('OK (入口在 ✓ 无密钥 ✓ manifest 在根部 ✓)');

    // ---- 5) 写出 ----
    const out = path.join(DIST, manifest.plugin_id.replace(/_/g, '-') +
        (isDev ? '-dev-' : '-') + manifest.version + '.zip');
    zip.write(out);
    if (!keepBundle && entryClean !== null) {
        try { fs.unlinkSync(path.join(DIST, '.release-bundle.js')); } catch (e) { }
    }
    const md5 = require('crypto').createHash('md5').update(fs.readFileSync(out)).digest('hex').slice(0, 12);
    console.log('  [5/5] 已生成: ' + path.relative(ROOT, out));
    console.log('        大小 ' + fs.statSync(out).size + ' 字节, md5 ' + md5 + ', ' + names.length + ' 个文件');
    console.log(isDev
        ? '        ✓ 开发包(含 dev/ 构建脚本与自测; 入口是干净产物, 装上去要自己填 API Key)'
        : '        ✓ 可以上传到资源市场(manifest.json 在根部, 入口已包含, 无密钥)');
}

try { main(); } catch (e) {
    console.error('\n  ✗ 发布包生成失败: ' + ((e && e.message) || e));
    process.exit(1);
}
