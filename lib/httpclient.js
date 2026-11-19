'use strict';

/**
 * HTTP 客户端适配层。
 *
 * 为什么需要它:
 *   文档 (SDK 0.3.2) 里的写法是 network.request({url, method, headers, body}),
 *   但在真实环境 miuxue/easybot:dev-full 上, network 是
 *   EasyBot.Plugin.Api.Http.HttpApi, **根本没有 request 成员**:
 *       'EasyBot.Plugin.Api.Http.HttpApi' does not contain a definition for 'request'
 *   为了同时兼容不同 build, 这里把候选写法都列出来逐个尝试, 并缓存首个可用的。
 */

const util = require('./util.js');

let _style = null;          // 上次成功的写法名
let _lastError = null;
let _headersWarned = false;
let _shapeLogged = false;
let _dropHeadersByDesign = false;   // 是否因为宿主只支持简单签名而丢掉了请求头

/** 把响应统一成 {status, body, data} */
function normalize(resp) {
    if (resp === null || resp === undefined) throw new Error('空响应');
    const status = (resp.status !== undefined) ? resp.status
        : (resp.Status !== undefined ? resp.Status : 200);
    let body = (resp.body !== undefined) ? resp.body
        : (resp.Body !== undefined ? resp.Body : '');
    if (typeof body !== 'string') {
        try { body = JSON.stringify(body); } catch (e) { body = String(body); }
    }

    // 优先解析 body 字符串 (最可靠, 不受宿主对象影响);
    // 解析不出来再退回 resp.data, 并把它从宿主对象转成普通 JS 对象。
    let data;
    if (body) {
        const parsed = util.safeJson(body, undefined);
        if (parsed !== undefined) data = parsed;
    }
    if (data === undefined) {
        const raw = (resp.data !== undefined) ? resp.data : resp.Data;
        if (raw !== undefined && raw !== null) data = util.plainify(raw);
    }
    const out = { status: Number(status) || 0, body: body, data: data };
    if (!_shapeLogged) {
        _shapeLogged = true;
        try {
            logger.info('[ai-chat] HTTP 响应形状: status={0} bodyType={1} bodyLen={2} dataType={3} (以 body 为准解析 JSON)',
                out.status, typeof body, body.length, typeof (resp.data !== undefined ? resp.data : resp.Data));
        } catch (e) { /* ignore */ }
    }
    return out;
}

/**
 * 当前可用的调用写法 (按优先级)。
 *
 * 真实环境实测 (miuxue/easybot:dev-full):
 *   network.get(url)            ✅ 可用
 *   network.post(url, body)     ✅ 可用
 *   network.get(url, headers)   ❌ 'HttpApi' does not contain a definition for 'get'
 *   network.request({...})      ❌ 同上
 *   network.post(url, body, h)  ❌ 同上
 * 也就是说这个 build 只支持「不带自定义请求头」的最简签名。
 */
// ---------------------------------------------------------------- 原生 .NET HTTP(反射)
//
// ★ 这段是"能不能摆脱转发"的关键。
//   插件 API 的 network 发出的 Content-Type 恒为 text/plain(.NET 把 Content-Type 归在
//   content 上, 而 RequestMessage 只暴露 url/method/headers/body), 严格接口会 400。
//   但宿主暴露了 dotnet.System, 而 System.Reflection.Assembly.Load 没被禁 —— 于是可以
//   反射加载 System.Net.Http, 用 Activator 造出 HttpClient/StringContent,
//   这样 Content-Type / 任意请求头都由我们自己控制, 完全不需要外部转发。
//
//   实测(回显服务器): ctype=application/json; charset=utf-8 auth=Bearer xxx 全部到位。
let _native = null;   // { client, HttpClientT, StringContentT, Encoding, ok, err }

function nativeInit() {
    if (_native) return _native;
    _native = { ok: false, err: '' };
    try {
        const dn = Function('return (typeof dotnet !== "undefined") ? dotnet : null')();
        if (!dn || !dn.System) throw new Error('没有 dotnet.System');
        const Sys = dn.System;
        const A = Sys.Reflection && Sys.Reflection.Assembly;
        if (!A || typeof A.Load !== 'function') throw new Error('没有 Assembly.Load');
        const asm = A.Load('System.Net.Http');
        if (!asm) throw new Error('加载 System.Net.Http 失败');
        const HttpClientT = asm.GetType('System.Net.Http.HttpClient');
        const StringContentT = asm.GetType('System.Net.Http.StringContent');
        if (!HttpClientT || !StringContentT) throw new Error('找不到 HttpClient/StringContent');
        // 找 3 参构造函数(string, Encoding, string)
        let ctor = null, sig = '', nCtor = -1;
        const ctors = StringContentT.GetConstructors();
        try { nCtor = ctors ? ctors.length : -2; } catch (e) { nCtor = -3; }
        for (let i = 0; i < (ctors ? ctors.length : 0); i++) {
            let ps = null, len = -1;
            try { ps = ctors[i].GetParameters(); len = ps ? ps.length : -8; } catch (e) { len = -9; }
            sig += '[' + len + ']';
            if (!ctor && len === 3) { ctor = ctors[i]; }
        }
        if (!ctor) {
            throw new Error('找不到 3 参构造函数; 个数=' + nCtor + ' 签名=' + sig +
                ' 数组类型=' + Object.prototype.toString.call(ctors) +
                ' StringContentT=' + (typeof StringContentT));
        }
        _native = {
            ok: true, err: '',
            Sys: Sys, HttpClientT: HttpClientT, ctor: ctor,
            Encoding: Sys.Text.Encoding,
            client: Sys.Activator.CreateInstance(HttpClientT)
        };
    } catch (e) {
        _native.err = String((e && e.message) || e);
    }
    return _native;
}

function nativeAvailable() {
    return nativeInit().ok === true;
}

/**
 * .NET 的 HttpStatusCode 枚举在 ClearScript 里**不是数字**(Number() 得到 NaN),
 * 而限流/错误分类都依赖状态码, 所以这里用多种方式兜底。
 * 实测有效: Convert.ToInt32(枚举) 与 枚举.GetHashCode()。
 */
function statusCodeOf(resp, Sys) {
    const raw = resp && resp.StatusCode;
    if (raw === undefined || raw === null) return 0;
    let n = Number(raw);
    if (!isNaN(n) && n > 0) return n;
    try {
        if (Sys && Sys.Convert && typeof Sys.Convert.ToInt32 === 'function') {
            n = Number(Sys.Convert.ToInt32(raw));
            if (!isNaN(n) && n > 0) return n;
        }
    } catch (e) { }
    try {
        n = Number(raw.GetHashCode());       // 枚举的哈希就是它的值
        if (!isNaN(n) && n > 0) return n;
    } catch (e) { }
    try {
        if (raw.value__ !== undefined) { n = Number(raw.value__); if (!isNaN(n) && n > 0) return n; }
    } catch (e) { }
    const txt = String(raw);
    const m = /(\d{3})/.exec(txt);
    if (m) return Number(m[1]);
    const map = {
        OK: 200, Created: 201, Accepted: 202, NoContent: 204, BadRequest: 400,
        Unauthorized: 401, Forbidden: 403, NotFound: 404, MethodNotAllowed: 405,
        RequestTimeout: 408, Conflict: 409, TooManyRequests: 429, InternalServerError: 500,
        BadGateway: 502, ServiceUnavailable: 503, GatewayTimeout: 504
    };
    if (map[txt] !== undefined) return map[txt];
    try { if (resp.IsSuccessStatusCode) return 200; } catch (e) { }
    return 0;
}

/** 用原生 HttpClient 发一次请求, 返回和 network 一样的形状 */
async function nativeRequest(url, method, headers, body) {
    const n = nativeInit();
    if (!n.ok) throw new Error('原生 HTTP 不可用: ' + n.err);
    const client = n.client;
    const m = String(method || 'GET').toUpperCase();

    // 请求头(逐条设置; Content-Type 由 StringContent 携带, 不能放在 DefaultRequestHeaders)
    try { client.DefaultRequestHeaders.Clear(); } catch (e) { }
    let contentType = 'application/json';
    Object.keys(headers || {}).forEach(function (k) {
        const low = k.toLowerCase();
        if (low === 'content-type') { contentType = String(headers[k]); return; }
        try { client.DefaultRequestHeaders.TryAddWithoutValidation(k, String(headers[k])); } catch (e) { }
    });

    let task;
    const hasBody = (body !== undefined && body !== null && m !== 'GET' && m !== 'HEAD');
    const content = hasBody ? n.ctor.Invoke([String(body), n.Encoding.UTF8, contentType]) : null;
    if (m === 'GET') task = client.GetAsync(url);
    else if (m === 'POST') task = client.PostAsync(url, content);
    else if (m === 'PUT') task = client.PutAsync(url, content);
    else if (m === 'DELETE') task = client.DeleteAsync(url);
    else throw new Error('原生 HTTP 暂不支持方法 ' + m);

    let resp;
    try {
        resp = await task;
        // ★ 宿主有时把 .NET Task 原样返回（await 得到 Task 对象 ✗）→ 从 Result 里取真响应 ✓
        if (resp && typeof resp.Status === 'number' && 'Result' in resp) resp = resp.Result;
    } catch (e) {
        if (task && typeof task.Wait === 'function') { task.Wait(); resp = task.Result; }
        else if (task && typeof task.GetAwaiter === 'function') { resp = task.GetAwaiter().GetResult(); }
        else throw e;
    }

    const status = statusCodeOf(resp, n.Sys);
    let text = '';
    try {
        const t = resp.Content.ReadAsStringAsync();
        text = (typeof t === 'string') ? t : await t;
    } catch (e) {
        try { text = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult(); } catch (e2) { text = ''; }
    }
    let data = null;
    try { data = util.safeJson(text, null); } catch (e) { }
    return { status: status, headers: {}, body: text, data: data };
}

function styles() {
    const net = (typeof network !== 'undefined' && network) ? network : null;
    if (!net) return [];
    const list = [];

    // 00) ★★★ 最优先: 原生 .NET HttpClient(反射) —— 请求头完全可控, 不需要任何外部转发
    if (nativeAvailable()) {
        list.push({
            name: 'native .NET HttpClient [请求头完全可控, 无需转发]',
            full: true,
            fn: function (url, method, headers, body) {
                return nativeRequest(url, method, headers, body);
            }
        });
    }

    // 0) 其次: 构造宿主暴露的 RequestMessage 对象。
    //    实测(ClearScript): 传 JS 字面量 network.request({url,method,headers}) 会报
    //    "HttpApi does not contain a definition for 'request'", 但传 **new RequestMessage()**
    //    就能成功, 并且 m.headers.Set('Authorization', ...) 真的会带上请求头!
    //    所以"插件发不了自定义请求头"这个早期结论是错的 —— 只是调用姿势不对。
    const RM = (typeof RequestMessage !== 'undefined') ? RequestMessage : null;
    if (RM && typeof net.request === 'function') {
        list.push({
            name: 'network.request(new RequestMessage()) [支持自定义头]',
            full: true,
            fn: function (url, method, headers, body) {
                const m = new RM();
                m.url = url;
                m.method = method;
                const hs = m.headers || m.Headers;
                if (hs && typeof hs.Set === 'function') {
                    Object.keys(headers || {}).forEach(function (k) {
                        const v = headers[k];
                        if (v !== undefined && v !== null) hs.Set(k, String(v));
                    });
                }
                if (body !== undefined && body !== null) m.body = body;
                return net.request(m);
            }
        });
        // 万一宿主属性名不同, 再补一个大小写变体
        list.push({
            name: 'network.request(new RequestMessage()) [Url/Method/Headers]',
            full: true,
            fn: function (url, method, headers, body) {
                const m = new RM();
                m.Url = url;
                m.Method = method;
                const hs = m.Headers || m.headers;
                if (hs && typeof hs.Set === 'function') {
                    Object.keys(headers || {}).forEach(function (k) { hs.Set(k, String(headers[k])); });
                }
                if (body !== undefined && body !== null) m.Body = body;
                return net.request(m);
            }
        });
    }

    // 0b) PascalCase 变体(某些宿主只暴露 Request)
    if (typeof net.Request === 'function') {
        list.push({
            name: 'network.Request({Url,Method,Headers,Body})',
            full: true,
            fn: function (url, method, headers, body) {
                return net.Request({ Url: url, Method: method, Headers: headers, Body: body });
            }
        });
    }

    // 1) 文档写法(某些宿主可能支持 JS 字面量)
    if (typeof net.request === 'function') {
        list.push({
            name: 'network.request({url,method,headers,body})',
            full: true,
            fn: function (url, method, headers, body) {
                return net.request({ url: url, method: method, headers: headers, body: body });
            }
        });
    }

    // 2) 最简签名 (不支持自定义请求头)
    const simple = {
        POST: ['post', function (net2, url, body) { return net2.post(url, body); }],
        PUT: ['put', function (net2, url, body) { return net2.put(url, body); }],
        DELETE: ['del', function (net2, url) { return net2.del(url); }],
        GET: ['get', function (net2, url) { return net2.get(url); }],
        HEAD: ['head', function (net2, url) { return net2.head(url); }],
        OPTIONS: ['options', function (net2, url) { return net2.options(url); }]
    };
    Object.keys(simple).forEach(function (m) {
        const name = simple[m][0];
        const call = simple[m][1];
        if (typeof net[name] !== 'function') return;
        list.push({
            name: 'network.' + name + '(url[,body]) [无自定义头]',
            full: false,
            method: m,
            fn: function (url, method, headers, body) { return call(net, url, body); }
        });
    });
    return list;
}

/** 描述可用成员, 便于排错 */
function describe() {
    const net = (typeof network !== 'undefined' && network) ? network : null;
    if (!net) return 'network 不存在';
    let keys = [];
    try { keys = Object.keys(net); } catch (e) { /* ignore */ }
    const interesting = keys.filter(function (k) {
        return /^(request|Request|send|Send|get|Get|post|Post|put|Put|delete|Delete|del|Del|head|Head|options|Options|create|Create|new|New)/.test(k);
    });
    return '共 ' + keys.length + ' 个成员; 疑似 HTTP 方法: ' + (interesting.slice(0, 30).join(', ') || '(无)');
}

/** 该错误是否意味着"写法不对", 值得换一种再试 */
function worthRetry(msg) {
    return /does not contain a definition|not a function|is not a function|找不到|无法|no such method/i.test(String(msg || ''));
}

/**
 * 发起请求
 * @param {{url:string, method?:string, headers?:object, body?:string, timeoutMs?:number}} opts
 * @returns {Promise<{status:number, body:string, data:any}>}
 */
async function request(opts) {
    const method = String(opts.method || 'GET').toUpperCase();
    const url = opts.url;
    const headers = opts.headers || {};
    const body = opts.body;
    const timeoutMs = opts.timeoutMs || 20000;

    const all = styles().filter(function (s) { return !s.method || s.method === method; });
    if (!all.length) {
        throw new Error('当前 EasyBot 的 network API 没有可用于 ' + method + ' 的调用方式 (' + describe() + ')');
    }
    // 首选上次成功的写法
    if (_style) {
        const names = all.map(function (s) { return s.name; });
        const i = names.indexOf(_style);
        if (i > 0) all.unshift(all.splice(i, 1)[0]);
    }

    for (let i = 0; i < all.length; i++) {
        try {
            const resp = await util.withTimeout(all[i].fn(url, method, headers, body), timeoutMs, 'HTTP ' + method);
                if (all[i].full === false) {
                    // ★ 这种写法会丢自定义请求头(Content-Type/Authorization) ✗
                    //   只用于【本次】请求, 绝不缓存成"首选", 否则以后一直用它 -> 400/401 永久化
                    try { logger.warning("[ai-chat] 本次退回不支持自定义请求头的写法(仅本次, 不记为首选): " + all[i].name); } catch (e) { }
                } else {
                    _style = all[i].name;
                    try { logger.info("[ai-chat] network 调用写法: {0}", _style); } catch (e) { }
                }
            // ★ 实测：退回"丢请求头"的写法后，严格接口会 400 (Content-Type) ✗
            //   → 一旦发现这种 400，立刻用【原生写法】重试一次（原生能自己设 Content-Type ✓）
            try {
                const _n0 = normalize(resp);
                if (_n0 && _n0.status === 400 && /content-type/i.test(String(_n0.body || '')) && !all[i].full) {
                    const _native = all.filter(function (x) { return x.full !== false; })[0];
                    if (_native) {
                        logger.warning('[ai-chat] 退回写法被接口拒(400 Content-Type) → 用原生写法重试一次 ✓');
                        const _r2 = await util.withTimeout(_native.fn(url, method, headers, body), timeoutMs, 'HTTP ' + method);
                        _style = _native.name;
                        return normalize(_r2);
                    }
                }
            } catch (e) { }
            const dropped = !all[i].full && headers && Object.keys(headers).length > 0;
            _dropHeadersByDesign = !all[i].full;
            if (dropped && !_headersWarned) {
                _headersWarned = true;
                try {
                    logger.warning('[ai-chat] 当前 EasyBot 的 network API 只支持简单签名, 自定义请求头(如 Authorization)已被忽略。' +
                        '若模型接口需要鉴权, 请改用 llm.authMode=query 或换用支持 network.request 的 EasyBot 版本。');
                } catch (e) { }
            }
            return normalize(resp);
        } catch (e) {
            _lastError = e;
                // ★ 超时 ≠ "写法不对": 该写法其实能工作, 只是慢 —— 换写法会丢请求头(实测导致 400/401 永久化)
                if (/超时|timed?\s*out/i.test(String((e && e.message) || e))) throw e;
                // 换写法是"降级"行为, 用 WARNING 记下来, 免得像这次一样只能靠翻日志才发现 ✗
                try { logger.warning("[ai-chat] 写法 " + all[i].name + " 失败(" + String((e && e.message) || e).slice(0, 80) + "), 尝试下一种写法"); } catch (e2) { }
            if (!worthRetry((e && e.message) || e) && i === all.length - 1) throw e;
            // 写法不对 -> 继续尝试下一种; 其它错误也先试完, 最后抛出
        }
    }
    throw _lastError || new Error('HTTP 请求失败');
}

/** 当前使用的写法 (调试用) */
function workingStyle() { return _style; }

/**
 * 当前是否真的能带自定义请求头。
 * 注意: 不能只看"有没有 request 方法"——这个 build 里 request 是个 function 但一调用就失败。
 * 只有实际成功调用过之后, 结论才可靠; 没调用过时返回 null(未知)。
 * @returns {boolean|null}
 */
function supportsHeaders() {
    if (_style) return !_dropHeadersByDesign;
    return null;
}

module.exports = {
    nativeAvailable: nativeAvailable,
    nativeRequest: nativeRequest,
    nativeInfo: function () { const n = nativeInit(); return { ok: n.ok, err: n.err }; },
    request: request,
    describe: describe,
    workingStyle: workingStyle,
    supportsHeaders: supportsHeaders
};
