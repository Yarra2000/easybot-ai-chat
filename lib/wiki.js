'use strict';

/**
 * Minecraft Wiki 查询（知识库里找不到指令时的兜底参考）。
 *
 * 设计取舍:
 *   - 优先度最低: 本服知识库/专用规则 > Wiki。Wiki 是**原版写法**, 本服可能装了模组改过指令,
 *     所以结果只当参考, 并且要求模型明确告知用户"这是 Wiki 的原版写法, 未必适用本服"。
 *   - 只走 MediaWiki 官方 API(JSON), 不抓 HTML 页面 —— 抓 HTML 又脆又容易被改版打挂。
 *     mcmod.cn 没有公开 API, 所以不适合运行时查, 需要的话应该人工抄进知识库。
 *   - 域名白名单: 只允许访问配置里列出的 API 地址, 免得模型拿着这个工具去抓任意 URL。
 *
 * 实测: 容器可以直接访问 https://zh.minecraft.wiki/api.php (网络通, 无需额外转发)。
 */

const util = require('./util.js');
const config = require('./config.js');
const httpclient = require('./httpclient.js');

function cfg() {
    return (config.get().tools && config.get().tools.wiki) || {};
}

function enabled() {
    return cfg().enabled === true;
}

/** 解析 "名称 | API地址" 行 */
function endpoints() {
    const raw = util.trim(cfg().endpoints) ||
        'Minecraft Wiki(中文) | https://zh.minecraft.wiki/api.php';
    return raw.split(/\r?\n/).map(function (line) {
        const t = util.trim(line);
        if (!t || t[0] === '#') return null;
        const i = t.indexOf('|');
        const name = i < 0 ? t : util.trim(t.slice(0, i));
        const api = i < 0 ? t : util.trim(t.slice(i + 1));
        if (!/^https?:\/\//i.test(api)) return null;
        // 域名白名单: 只允许 wiki 类站点
        if (!/^https?:\/\/[^/]*(wiki|minecraft|mcmod)[^/]*\//i.test(api)) return null;
        return { name: name, api: api };
    }).filter(Boolean);
}

/** 去掉 HTML 标签与多余空白 */
function stripHtml(text) {
    return util.trim(String(text || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' '));
}

function wikiTimeout() {
    const t = Number(cfg().timeoutMs);
    return t > 0 ? t : 25000;
}

async function getJson(url, timeoutMs) {
    // ★ 现在能发自定义请求头了(用 new RequestMessage()) —— 之前 Wiki 的反爬就是因为
    //   插件带不上 User-Agent 才 403/挑战页。这里补上 UA 和 Accept。
    const resp = await httpclient.request({
        method: 'GET',
        url: url,
        timeoutMs: timeoutMs || wikiTimeout(),
        headers: {
            'User-Agent': 'easybot-ai-chat/1.0 (Minecraft Wiki lookup; +https://github.com/)',
            'Accept': 'application/json'
        }
    });
    const raw = (resp && (typeof resp.body === 'string' ? resp.body : null)) || '';
    const parsed = util.safeJson(raw, null);
    if (!parsed) {
        const alt = resp && resp.data ? resp.data : null;
        if (alt && typeof alt === 'object') return alt;
        throw new Error('Wiki 返回的不是 JSON (前 120 字: ' + util.truncate(raw, 120) + ')');
    }
    return parsed;
}

/** 取纯文本(HTML) —— MC百科 返回的是网页, 不是 JSON */
async function getText(url, timeoutMs) {
    const resp = await httpclient.request({
        method: 'GET',
        url: url,
        timeoutMs: timeoutMs || wikiTimeout(),
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; easybot-ai-chat/1.2) Minecraft-Mod-Encyclopedia-Lookup',
            'Accept': 'text/html,application/xhtml+xml'
        }
    });
    return String((resp && (typeof resp.body === 'string' ? resp.body : '')) || '');
}

/**
 * ★ MC百科(mcmod.cn) 搜索 —— 专治"原版 Wiki 查不到的【模组】内容" ✓
 *   实测(2026-10): https://search.mcmod.cn/s?key=<urlencoded> 可直接访问, 无 Cloudflare 挑战 ✓
 *   返回 HTML 结构:  div.result-item > div.head > a(href, 标题里 <em> 是高亮) / div.body 摘要 / div.foot 快照
 *   @returns {Array<{title, snippet, url}>}
 */
async function searchMcmod(query, limit) {
    const q = util.trim(String(query || ''));
    if (!q) return [];
    const cap = Math.max(1, Math.min(10, Number(limit) || 5));
    const html = await getText('https://search.mcmod.cn/s?key=' + encodeURIComponent(q));
    const out = [];
    const re = /<div class="result-item">([\s\S]*?)<div class="foot">/g;
    let m;
    while ((m = re.exec(html)) !== null && out.length < cap) {
        const block = m[1];
        const a = /<a[^>]+href="(https:\/\/www\.mcmod\.cn\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!a) continue;
        const title = util.trim(stripHtml(a[2])).replace(/\s+/g, ' ');
        if (!title) continue;
        const bm = /<div class="body">([\s\S]*)$/.exec(block);
        let body = bm ? stripHtml(bm[1]) : '';
        body = util.trim(body)
            .replace(/\[h\d=[^\]]*\]/g, ' ')      // mcmod 的 wiki 标记: [h1=标题]
            .replace(/\[mark:[^\]]*\]/g, ' ')      // 以及 [mark:title_menu]
            .replace(/\s+/g, ' ');
        out.push({ title: title, url: a[1], snippet: util.truncate(body, 240) });
    }
    return out;
}

/**
 * 搜索 Wiki
 * @returns {Array<{title, snippet, url}>}
 */
async function search(query, ep) {
    const q = util.trim(String(query || ''));
    if (!q) return [];
    const limit = Number(cfg().maxResults) > 0 ? Number(cfg().maxResults) : 3;
    const url = ep.api + '?action=query&list=search&format=json&srlimit=' + limit +
        '&srsearch=' + encodeURIComponent(q);
    const data = await getJson(url);
    const list = (data && data.query && data.query.search) || [];
    return list.map(function (it) {
        return {
            title: String(it.title || ''),
            snippet: stripHtml(it.snippet),
            url: ep.api.replace(/api\.php.*$/, '') + 'w/' + encodeURIComponent(String(it.title || '').replace(/ /g, '_'))
        };
    });
}

/**
 * 取某个页面的纯文本正文(MediaWiki extracts)
 */
async function pageText(title, ep) {
    const url = ep.api + '?action=query&prop=extracts&explaintext=1&format=json&redirects=1&titles=' +
        encodeURIComponent(title);
    const data = await getJson(url);
    const pages = (data && data.query && data.query.pages) || {};
    const keys = Object.keys(pages);
    if (!keys.length) return '';
    const text = pages[keys[0]] && pages[keys[0]].extract;
    return util.trim(String(text || ''));
}

/**
 * 查询入口: 搜索 + 取最佳命中的正文
 * @returns {{ok, query, source, results, detail, note}}
 */
async function lookup(query, opts) {
    opts = opts || {};
    if (!enabled()) {
        return { ok: false, error: 'Wiki 查询未启用(需在配置里打开 tools.wiki.enabled)' };
    }
    const eps = endpoints();
    if (!eps.length) return { ok: false, error: '没有可用的 Wiki API 地址(检查 tools.wiki.endpoints)' };

    /**
     * ★★ 端点选择(实测踩过的坑 ✗):
     *   1) 模型有时拿【英文名】去查(query="shulker 生成 …"), 中文站搜不到 -> 0 条结果,
     *      然后它还会跟用户说"我查的是英文版 wiki" ✗ —— 其实站点是中文的
     *   2) 所以: 【永远优先中文站】✓, 中文站搜不到时【自动换另一条端点再试一次】✓
     *   3) source 参数改成模糊匹配("中文"/"zh"/"English" 都能认), 认不出也回退到中文站 ✓
     */
    function isZh(ep) { return /中文|\bzh\b|\bcn\b/i.test(String(ep && ep.name || '')); }
    const zhList = eps.filter(isZh);
    let ep = eps[0];
    if (opts.source) {
        const want = String(opts.source);
        ep = eps.filter(function (e) {
            return e.name === want || e.name.indexOf(want) >= 0 || want.indexOf(e.name) >= 0;
        })[0] || (zhList[0] || eps[0]);
    } else if (zhList.length) {
        ep = zhList[0];                       // ★ 默认就用中文站 ✓
    }

    let results = await search(query, ep);
    let fellBack = '';
    if (!results.length) {
        // ★ 自动兜底: 换另一条端点再搜一次(典型场景: 英文名查中文站) ✓
        const alt = eps.filter(function (e) { return e !== ep; })[0];
        if (alt) {
            try {
                const r2 = await search(query, alt);
                if (r2.length) { results = r2; fellBack = ep.name; ep = alt; }
            } catch (e) { }
        }
    }
    if (!results.length) {
        return { ok: true, query: query, source: ep.name, results: [], detail: '', note: 'Wiki 上也没搜到相关条目' };
    }

    let detail = '';
    let detailTitle = '';
    if (opts.deep !== false && cfg().deepFetch !== false) {
        // 优先取标题像"命令/xxx"的条目, 那才是指令语法页
        const prefer = results.filter(function (r) { return /命令|command/i.test(r.title); });
        const pick = (prefer.length ? prefer : results)[0];
        try {
            let text = await pageText(pick.title, ep);
            // 指令页开头通常是用法, 截断到配置上限
            const max = Number(cfg().maxChars) > 0 ? Number(cfg().maxChars) : 1500;
            if (text) {
                detailTitle = pick.title;
                detail = util.truncate(text, max);
            }
        } catch (e) {
            detail = '';
        }
    }

    return {
        ok: true,
        query: query,
        source: ep.name,
        results: results,
        detailTitle: detailTitle,
        detail: detail,
        note: (fellBack ? ('中文站没搜到, 这条是在 ' + ep.name + ' 上查到的。') : '') +
            '这是 Minecraft Wiki 上的**原版**写法参考。本服可能装了模组改过指令, ' +
            '所以请把差异告诉用户, 不要直接用它执行会改变服务器状态的指令。'
    };
}

/** 给模型看的结果文本 */
function render(res) {
    if (!res || res.ok === false) return 'Wiki 查询失败: ' + ((res && res.error) || '未知错误');
    const lines = [];
    if (!res.results || !res.results.length) {
        return '在 ' + res.source + ' 上也没搜到 "' + res.query + '" 相关的指令条目。可以换关键词再搜, ' +
            '或直接告诉用户本服没有这个功能。';
    }
    lines.push('来源: ' + res.source + ' (原版写法参考, 未必适用本服)');
    res.results.forEach(function (r) {
        lines.push('- ' + r.title + ': ' + util.truncate(r.snippet, 200));
    });
    if (res.detail) {
        lines.push('');
        lines.push('【' + res.detailTitle + '】正文摘录:');
        lines.push(res.detail);
    }
    if (res.note) {
        lines.push('');
        lines.push('注意: ' + res.note);
    }
    return lines.join('\n');
}

/**
 * ★ 抓 MC百科 的一个页面: 标题 / 简介 / 正文插图
 *   实测: 正文插图在 i.mcmod.cn/editor/upload/… (webp/gif/png) ✓
 *   要排掉: /avatar/(头像) /cover/(模组封面) /icon/(物品图标) /gui/(背景) /static/(站点资源) ✗
 */
async function mcmodPage(url) {
    const html = await getText(url);
    const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
    const descM = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
    const imgs = [];
    const re = /(?:https?:)?\/\/i\.mcmod\.cn\/[^"'\s\)]+/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        let u = m[0];
        if (!/^https?:/i.test(u)) u = 'https:' + u;
        if (/\/avatar\/|\/cover\/|\/icon\/|\/gui\/|\/static\//i.test(u)) continue;
        if (!/\.(png|jpe?g|gif|webp)(@|$)/i.test(u)) continue;
        if (imgs.indexOf(u) < 0) imgs.push(u);
    }
    // ★ 正文: 物品页的 common-icon-text 块里就是【属性 + 合/用途】, 模组页是 class-post-frame
    //   之前只取了 meta description(一句套话), 所以模型总说"百科没写全" ✗
    const sections = [];
    const parts = html.split(/class="[^"]*common-icon-text[^"]*"/).slice(1, 5);
    parts.forEach(function (p) {
        let t = stripHtml(p.slice(0, 3000)).replace(/\s+/g, ' ').trim();
        // 清理残留的 HTML 属性碎片(切分位置可能落在标签中间) + 开头噪声
        t = t.replace(/[a-zA-Z-]+="[^"]*"/g, ' ')
             .replace(/style='[^']*'/g, ' ')
             .replace(/^[\s\|:：>]+/, ' ')
             .replace(/\s+/g, ' ')
             .trim();
        // 跳过"编辑历史/最近参与编辑"这类无内容价值的块
        if (/最近参与编辑|查看历史改动|编辑次数/.test(t)) return;
        if (t.length > 20 && sections.indexOf(t) < 0) sections.push(util.truncate(t, 300));
    });
    // ★★ 物品页的关键内容是【材料统计 / 输入>>输出 / 备注】那一段 —— 实测它就在 HTML 文字里 ✓
    //   (之前只抓 common-icon-text, 把配方整段漏了 ✗ -> 模型只好说"配方没列出来" ✗)
    if (!sections.length) {
        const whole = stripHtml(html).replace(/[a-zA-Z-]+="[^"]*"/g, ' ')
            .replace(/style='[^']*'/g, ' ').replace(/\s+/g, ' ').trim();
        const i0 = whole.indexOf('资料分类');
        const i1 = whole.indexOf('材料统计');
        const st = i0 >= 0 ? i0 : (i1 >= 0 ? Math.max(0, i1 - 250) : -1);
        if (st >= 0) {
            // ① 简介/来源/用途那一段(用户问"怎么获得/有什么用"主要靠它) ✓
            sections.push(util.truncate(whole.slice(st, st + 1500), 1500));
            // ② 材料统计/输入>>输出/备注 那一段(精确配方) —— 它在页面里位置靠后, 单独截一段 ✓
            const iMat = whole.indexOf('材料统计');
            if (iMat >= 0 && iMat > st + 50) {
                sections.push(util.truncate(whole.slice(iMat, iMat + 900), 900));
            }
        }
    }
    if (!sections.length) {
        const fm = /class="[^"]*class-post-frame[^"]*"/.exec(html);
        if (fm) {
            const t = stripHtml(html.slice(fm.index, fm.index + 6000)).replace(/\s+/g, ' ').trim();
            if (t.length > 20) sections.push(util.truncate(t, 400));
        }
    }
    return {
        title: titleM ? stripHtml(titleM[1]).replace(/\s+/g, ' ').trim() : '',
        desc: descM ? stripHtml(descM[1]).replace(/\s+/g, ' ').trim() : '',
        sections: sections.slice(0, 3),
        images: imgs.slice(0, 3)
    };
}

/** 本次回复要附带的图片(按会话存, 由回复逻辑取走) */
const _pageImages = {};
function stashImages(sessionKey, list) {
    if (!sessionKey || !list || !list.length) return;
    _pageImages[sessionKey] = list.slice(0, 3);
}
function takeImages(sessionKey) {
    const v = _pageImages[sessionKey] || [];
    delete _pageImages[sessionKey];
    return v;
}

module.exports = {
    enabled: enabled,
    mcmodPage: mcmodPage,
    stashImages: stashImages,
    takeImages: takeImages,
    searchMcmod: searchMcmod,
    endpoints: endpoints,
    search: search,
    pageText: pageText,
    lookup: lookup,
    render: render,
    stripHtml: stripHtml
};
