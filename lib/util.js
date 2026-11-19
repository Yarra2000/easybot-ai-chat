'use strict';

/**
 * 通用工具函数集合。
 * 注意: 本文件不依赖任何 EasyBot 特有对象, 方便在 Node 下做离线自测。
 */

/**
 * 跨环境 setTimeout。
 * 注意: EasyBot 的 threading.setTimeout 是宿主方法代理, 没有 .bind(),
 * 所以这里用闭包包一层, 不能直接 bind。
 */
const _setTimeout = (typeof threading !== 'undefined' && threading && typeof threading.setTimeout === 'function')
    ? function (cb, ms) { return threading.setTimeout(cb, ms); }
    : (typeof setTimeout === 'function' ? function (cb, ms) { return setTimeout(cb, ms); } : null);

/** 睡眠指定毫秒 */
function sleep(ms) {
    return new Promise(function (resolve) {
        const t = Math.max(0, Math.floor(ms || 0));
        if (_setTimeout) _setTimeout(resolve, t);
        else resolve();
    });
}

/** [min, max] 闭区间随机整数 */
function randInt(min, max) {
    min = Math.floor(min);
    max = Math.floor(max);
    if (max < min) { const t = min; min = max; max = t; }
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** 随机浮点 [0,1) */
function random() { return Math.random(); }

/** 概率命中 */
function chance(p) { return Math.random() < (p || 0); }

/** 从数组随机取一个 (空数组返回 null) */
function pick(arr) {
    if (!arr || !arr.length) return null;
    return arr[randInt(0, arr.length - 1)];
}

/** 安全 JSON 解析, 失败返回 fallback */
function safeJson(text, fallback) {
    if (text === null || text === undefined) return fallback === undefined ? null : fallback;
    if (typeof text === 'object') return text;
    try { return JSON.parse(String(text)); } catch (e) { return fallback === undefined ? null : fallback; }
}

/** 安全 JSON 序列化 (失败返回 "{}") */
function safeStringify(obj) {
    try { return JSON.stringify(obj); } catch (e) { return '{}'; }
}

/** 深拷贝 (仅 JSON 安全数据) */
function clone(obj) {
    if (obj === null || obj === undefined) return obj;
    try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return obj; }
}

/** 截断字符串到 n 个字符 */
function truncate(text, n) {
    const s = String(text === null || text === undefined ? '' : text);
    if (s.length <= n) return s;
    return s.slice(0, Math.max(0, n - 1)) + '…';
}

/** 去除首尾空白 */
function trim(text) {
    return String(text === null || text === undefined ? '' : text).trim();
}

/** 转义 HTML */
function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** 时间戳 (毫秒) */
function now() { return Date.now(); }

/** 格式化为本地时间字符串 */
function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
        p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 限制数值区间 */
function clamp(v, min, max) {
    v = Number(v);
    if (isNaN(v)) v = min;
    return Math.min(max, Math.max(min, v));
}

/**
 * 把各种"类数组"统一转成 JS 数组。
 *
 * 真实 EasyBot 环境里集合可能是:
 *   - 普通 JS Array
 *   - .NET IList<T> 代理 (有 Count, 但索引器/枚举方式随 ClearScript 配置而变)
 *   - .NET IEnumerator<T> (MoveNext/Current)
 * 这里按多种策略逐个尝试, 并通过 onStrategy 回调报告命中的策略(便于排查)。
 *
 * @param {any} x
 * @param {Function} [onStrategy] (name) => void
 */
function toArray(x, onStrategy) {
    if (x === null || x === undefined) return [];
    if (Array.isArray(x)) return x;
    const report = typeof onStrategy === 'function' ? onStrategy : function () { };

    // 1) AsArray() (EasyBot 自己的脚本专用方法)
    try {
        if (typeof x.AsArray === 'function') {
            const r = x.AsArray();
            if (Array.isArray(r)) { report('AsArray'); return r; }
            if (r && r !== x) {
                const inner = toArray(r, function () { });
                if (inner.length) { report('AsArray->inner'); return inner; }
            }
        }
    } catch (e) { /* 下一个策略 */ }

    // 2) ToArray() (.NET / LINQ)
    try {
        if (typeof x.ToArray === 'function') {
            const r = x.ToArray();
            if (Array.isArray(r)) { report('ToArray'); return r; }
            if (r && r !== x) {
                const inner = toArray(r, function () { });
                if (inner.length) { report('ToArray->inner'); return inner; }
            }
        }
    } catch (e) { /* 下一个策略 */ }

    // 3) GetEnumerator() / MoveNext
    try {
        if (typeof x.GetEnumerator === 'function') {
            const en = x.GetEnumerator();
            if (en && typeof en.MoveNext === 'function') {
                const out = [];
                let guard = 0;
                while (en.MoveNext() && guard++ < 10000) out.push(en.Current);
                if (out.length || x.Count === 0) { report('GetEnumerator'); return out; }
            }
        }
    } catch (e) { /* 下一个策略 */ }
    if (typeof x.MoveNext === 'function') {
        const out = [];
        let guard = 0;
        try {
            while (x.MoveNext() && guard++ < 10000) out.push(x.Current);
            if (out.length) { report('enumerator'); return out; }
        } catch (e) { /* ignore */ }
    }

    // 元素个数
    let count = null;
    if (typeof x.Count === 'number') count = x.Count;
    else if (typeof x.length === 'number') count = x.length;

    // 4) 索引器方法
    if (count !== null) {
        const names = ['get_Item', 'Item', 'get', 'ElementAt'];
        for (let n = 0; n < names.length; n++) {
            try {
                if (typeof x[names[n]] === 'function') {
                    const out = [];
                    for (let i = 0; i < count; i++) out.push(x[names[n]](i));
                    if (out.length || count === 0) { report('indexer:' + names[n]); return out; }
                }
            } catch (e) { /* 下一个 */ }
        }

        // 5) 中括号索引
        try {
            const out = [];
            for (let i = 0; i < count; i++) out.push(x[i]);
            if (out.length && out[0] !== undefined) { report('bracket'); return out; }
        } catch (e) { /* 下一个 */ }
    }

    // 6) 退化: 当作 length 可用的对象
    try {
        const out = Array.prototype.slice.call(x);
        if (out.length) { report('slice'); return out; }
    } catch (e) { /* ignore */ }

    return [];
}

/**
 * 把可能返回 Promise 的函数安全地 await 并捕获异常
 * @returns {{ok: boolean, value?: any, error?: any}}
 */
async function attempt(fn, ...args) {
    try {
        const value = await fn(...args);
        return { ok: true, value: value };
    } catch (e) {
        return { ok: false, error: e };
    }
}

/** 给 Promise 加超时 */
function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
        let done = false;
        const timer = _setTimeout ? _setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('超时(' + (label || 'task') + ') ' + ms + 'ms'));
        }, Math.max(1, ms || 1000)) : null;
        Promise.resolve(promise).then(function (v) {
            if (done) return;
            done = true;
            if (timer && typeof clearTimeout === 'function') { try { clearTimeout(timer); } catch (e) { } }
            resolve(v);
        }, function (e) {
            if (done) return;
            done = true;
            if (timer && typeof clearTimeout === 'function') { try { clearTimeout(timer); } catch (e) { } }
            reject(e);
        });
    });
}

/**
 * 把 .NET 宿主对象递归转成普通 JS 值 (Dictionary / IList / 普通对象)。
 * 仅在需要读取宿主对象内部数据时使用, 做多策略尝试, 失败则退化。
 */
function plainify(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function') return undefined;
    if (depth > 5) return String(v);
    if (Array.isArray(v)) return v.map(function (x) { return plainify(x, depth + 1); });

    // IList / 数组代理
    if (typeof v.Count === 'number') {
        const arr = toArray(v);
        if (arr.length || v.Count === 0) return arr.map(function (x) { return plainify(x, depth + 1); });
    }
    // Dictionary 代理
    try {
        if (v.Keys !== undefined && v.Keys !== null) {
            const out = {};
            const get = (typeof v.get_Item === 'function') ? function (k) { return v.get_Item(k); }
                : (typeof v.Item === 'function' ? function (k) { return v.Item(k); } : function (k) { return v[k]; });
            toArray(v.Keys).forEach(function (k) { out[String(k)] = plainify(get(k), depth + 1); });
            if (Object.keys(out).length) return out;
        }
    } catch (e) { /* 继续 */ }

    const out = {};
    let n = 0;
    try {
        Object.keys(v).forEach(function (k) {
            const val = plainify(v[k], depth + 1);
            if (val !== undefined) { out[k] = val; n++; }
        });
    } catch (e) { /* ignore */ }
    if (n) return out;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
}

/** 忽略大小写的包含判断 (needle 为空返回 false) */
function containsIgnoreCase(haystack, needle) {
    if (!needle) return false;
    return String(haystack || '').toLowerCase().indexOf(String(needle).toLowerCase()) >= 0;
}

/** 是否任意一项被包含 */
function containsAny(haystack, needles) {
    if (!needles || !needles.length) return false;
    for (let i = 0; i < needles.length; i++) {
        if (containsIgnoreCase(haystack, needles[i])) return true;
    }
    return false;
}

/** 生成短随机 ID */
function shortId() {
    return Math.random().toString(36).slice(2, 8);
}

/** 清洗工具名: 仅保留 [A-Za-z0-9_-], 长度 <= 64 */
function sanitizeToolName(name) {
    let s = String(name || '').replace(/[^A-Za-z0-9_-]/g, '_');
    if (s.length > 64) s = s.slice(0, 64);
    return s || ('tool_' + shortId());
}

module.exports = {
    sleep: sleep,
    randInt: randInt,
    random: random,
    chance: chance,
    pick: pick,
    safeJson: safeJson,
    safeStringify: safeStringify,
    clone: clone,
    truncate: truncate,
    trim: trim,
    escapeHtml: escapeHtml,
    now: now,
    formatTime: formatTime,
    clamp: clamp,
    toArray: toArray,
    attempt: attempt,
    withTimeout: withTimeout,
    containsIgnoreCase: containsIgnoreCase,
    containsAny: containsAny,
    shortId: shortId,
    sanitizeToolName: sanitizeToolName,
    plainify: plainify,
};
