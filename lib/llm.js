'use strict';

/**
 * 大模型客户端 (OpenAI 兼容的 /chat/completions 协议)。
 *
 * 兼容: DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / Ollama(/v1) / one-api / new-api 等
 * 支持: 普通对话、function calling (tools)、多轮工具调用循环
 */

const util = require('./util.js');
const humanize = require('./humanize.js');
const config = require('./config.js');
const http = require('./httpclient.js');

// ---------------- 限流(429)冷却 ----------------
// 实测: Agnes 免费额度限流后会返回 429 "reached the API rate limit for free users"。
// 命中后进入冷却, 期间直接快速失败, 不再打接口、也不在群里刷屏。
let _cooldownUntil = 0;
let _cooldownReason = '';

function setCooldown(ms, reason) {
    const until = util.now() + Math.max(1000, Number(ms) || 60000);
    if (until > _cooldownUntil) {
        _cooldownUntil = until;
        _cooldownReason = reason || '';
    }
}
function cooldownLeftMs() { return Math.max(0, _cooldownUntil - util.now()); }
function clearCooldown() { _cooldownUntil = 0; _cooldownReason = ''; }
function inCooldown() { return cooldownLeftMs() > 0; }

/** 规范化请求地址: baseUrl 可以是 https://x/v1 也可以是完整 .../chat/completions */
function endpoint(baseUrl) {
    let base = util.trim(baseUrl);
    if (!base) return '';
    base = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    if (/\/v\d+$/i.test(base)) return base + '/chat/completions';
    if (/\/completions$/i.test(base)) return base;
    return base + '/chat/completions';
}

/** 组装请求头 (authMode != header 时不放 Authorization) */
function buildHeaders(cfg) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    if (cfg.apiKey && (cfg.authMode === undefined || cfg.authMode === 'header')) {
        headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    }
    const extra = cfg.extraHeaders || {};
    Object.keys(extra).forEach(function (k) {
        if (extra[k] !== null && extra[k] !== undefined) headers[k] = String(extra[k]);
    });
    return headers;
}

/**
 * 组装请求地址。
 * 某些 EasyBot build 的 network API 不支持自定义请求头, 这时可以把密钥放到查询串里
 * (llm.authMode = "query"), 只要模型服务端支持这种鉴权方式即可。
 */
/**
 * 把真实上游地址包装成本机通用代理的地址。
 *
 * 为什么需要: 插件发不出 Content-Type(它属于 content, 不属 request headers),
 * 而绝大多数 OpenAI 兼容接口都强制要求 application/json。
 * 所以本机跑一个通用转发, 由它补上 Content-Type —— 关键是"目标地址由请求决定",
 * 换供应商只要改插件配置里的 baseUrl, **不用动转发**。
 *
 *   baseUrl   = https://api.deepseek.com/v1
 *   relayBase = http://192.0.2.10:18081/proxy
 *   -> http://192.0.2.10:18081/proxy/https/api.deepseek.com/v1/chat/completions
 */
function viaRelay(upstreamUrl, relayBase) {
    const relay = util.trim(relayBase).replace(/\/+$/, '');
    if (!relay) return upstreamUrl;
    const m = /^(https?):\/\/([^/]+)(\/[\s\S]*)?$/.exec(String(upstreamUrl || ''));
    if (!m) return upstreamUrl;
    const scheme = m[1];
    const host = m[2];
    let rest = m[3] || '';
    // 查询串也塞进路径里(转发的正则会把整段当上游 URL)
    const qi = rest.indexOf('?');
    let query = '';
    if (qi >= 0) { query = rest.slice(qi); rest = rest.slice(0, qi); }
    rest = rest.replace(/^\/+/, '');
    return relay + '/' + scheme + '/' + host + (rest ? '/' + rest : '') + query;
}

// 传输方式记忆: null=未知, 'direct'=直连可用, 'relay'=需要走通用代理(补 Content-Type)
let _transport = null;

/** 这个错误是不是"接口嫌 Content-Type 不是 application/json" */
function isContentTypeError(e) {
    return /only supports Content-Type|Content-Type: application\/json|Unsupported Media Type/i.test(String((e && e.message) || e));
}

function transportName() { return _transport || '(未探测)'; }

function buildUrlFor(cfg, useRelay) {
    const url = endpoint(cfg.baseUrl);
    if (!url) return url;
    let out = useRelay ? viaRelay(url, cfg.relayBase) : url;
    if (cfg.authMode === 'query' && cfg.apiKey) {
        const param = util.trim(cfg.authQueryParam) || 'api_key';
        const sep = out.indexOf('?') >= 0 ? '&' : '?';
        out += sep + encodeURIComponent(param) + '=' + encodeURIComponent(cfg.apiKey);
    }
    return out;
}

/** 兼容旧调用: 配了代理就走代理 */
function buildUrl(cfg) {
    return buildUrlFor(cfg, !!util.trim(cfg.relayBase));
}

/**
 * 发 POST JSON (带一次重试)。底层走自适应 HTTP 适配层。
 */
async function postJson(url, body, headers, timeoutMs, retryLeft) {
    const attempts = (retryLeft === undefined ? 1 : retryLeft) + 1;
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            return await http.request({
                url: url,
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body),
                timeoutMs: timeoutMs
            });
        } catch (e) {
            lastErr = e;
            // 限流/额度问题重试也没用, 直接抛
            if (/限流|429|额度/.test(String((e && e.message) || e))) break;
            if (i < attempts - 1) await util.sleep(500 + util.randInt(0, 500));
        }
    }
    throw lastErr || new Error('请求失败');
}

/** 从响应里取出 JSON */
function parseResponse(resp) {
    if (!resp) throw new Error('空响应');
    let data = (resp.data && typeof resp.data === 'object') ? resp.data : null;
    if (!data) {
        const text = resp.body || '';
        data = util.safeJson(text, null);
        if (!data) {
            throw new Error('响应不是合法 JSON (HTTP ' + resp.status + '): ' + util.truncate(text, 300));
        }
    }
    if (resp.status && (resp.status < 200 || resp.status >= 300)) {
        const msg = (data && data.error && (data.error.message || data.error.code)) || util.truncate(resp.body || '', 300);
        if (resp.status === 429 || /rate limit|too many requests|quota|余额|额度/i.test(String(msg))) {
            const sec = Number(config.llm().rateLimitCooldownSec) || 60;
            setCooldown(sec * 1000, String(msg));
            throw new Error('接口限流/额度不足(HTTP ' + resp.status + '): ' + msg +
                ' —— 已进入 ' + sec + ' 秒冷却, 期间不再请求');
        }
        throw new Error('接口返回 HTTP ' + resp.status + ': ' + msg);
    }
    if (data.error) {
        throw new Error('接口返回错误: ' + (data.error.message || util.safeStringify(data.error)));
    }
    return data;
}

/** 清理工具参数里的思维链残留(只删内置标签, 不套自定义正则, 免得破坏 JSON) */
function cleanArgs(args) {
    if (typeof args !== 'string') return args;
    if (args.indexOf('<') < 0 && args.indexOf('思考') < 0) return args;
    return humanize.stripArtifacts(args, true);
}

/** 规范化 tool_calls (兼容旧版 function_call) */
function normalizeToolCalls(message) {
    const out = [];
    if (!message) return out;
    if (Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach(function (tc) {
            if (!tc) return;
            const fn = tc.function || {};
            out.push({
                id: tc.id || ('call_' + util.shortId()),
                name: fn.name || tc.name || '',
                arguments: cleanArgs(fn.arguments !== undefined ? fn.arguments : (tc.arguments || '{}'))
            });
        });
    }
    if (!out.length && message.function_call && message.function_call.name) {
        out.push({
            id: 'call_' + util.shortId(),
            name: message.function_call.name,
            arguments: cleanArgs(message.function_call.arguments || '{}')
        });
    }
    return out;
}

/**
 * 单次对话请求
 * @returns {Promise<{content: string, toolCalls: Array, finishReason: string, usage: any, raw: any}>}
 */
async function chatOnce(opts) {
    const cfg = config.llm();
    if (!opts.__skipCooldown && inCooldown()) {
        throw new Error('模型接口冷却中, 还需等待 ' + Math.ceil(cooldownLeftMs() / 1000) + ' 秒 (上次: ' +
            util.truncate(_cooldownReason, 80) + ')');
    }
    const model = opts.model || cfg.model;
    const body = {
        model: model,
        messages: opts.messages,
        temperature: opts.temperature === undefined ? cfg.temperature : opts.temperature,
        stream: false
    };
    if (opts.maxTokens || cfg.maxTokens) body.max_tokens = opts.maxTokens || cfg.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const tools = opts.tools || [];
    if (tools.length && cfg.apiStyle === 'functions') {
        body.functions = tools.map(function (t) { return t.function; });
        body.function_call = 'auto';
    } else if (tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    if (opts.extraBody && typeof opts.extraBody === 'object') {
        Object.keys(opts.extraBody).forEach(function (k) { body[k] = opts.extraBody[k]; });
    }

    if (!endpoint(cfg.baseUrl)) throw new Error('未配置大模型接口地址 (llm.baseUrl)');
    const timeoutMs = Number(opts.timeoutMs || cfg.timeoutMs) || 60000;
    const canRelay = !!util.trim(cfg.relayBase);

    // 传输策略:
    //   direct  直连 —— 接口宽容(不强制 application/json)时最省事, 不需要任何转发
    //   relay   经通用代理 —— 由代理补上 Content-Type(插件自己设不了它)
    // 未知时**先试直连**, 被 Content-Type 拒了才自动切代理, 并把结论记住(后续直接走代理)。
    // 有原生 .NET HTTP 就完全不需要转发(请求头由我们自己控制)
    const canNative = !!(http.nativeAvailable && http.nativeAvailable());
    let useRelay = canNative ? false : (_transport === 'relay');
    if (canNative && _transport !== 'native') {
        _transport = 'native';
        logger.info('[ai-chat] 已启用原生 .NET HTTP(可自控 Content-Type 等请求头) —— 不需要通用代理');
    }
    if (!canNative && _transport === null && !canRelay) useRelay = false;

    // 发一次并解析(HTTP 400 是由 parseResponse 抛出的, 所以必须把它也包进来)
    async function send(useRelay2) {
        const r = await postJson(buildUrlFor(cfg, useRelay2), body, buildHeaders(cfg), timeoutMs, 1);
        return parseResponse(r);
    }

    let data;
    try {
        data = await send(useRelay);
        if (useRelay) { _transport = 'relay'; }
        else if (_transport === null || (_transport === 'native' && false)) {
            _transport = 'direct';
            logger.info('[ai-chat] 该接口接受 text/plain, 可直连 —— 不需要通用代理(relayBase 可以留空)');
        }
    } catch (e) {
        if (!useRelay && !canNative && canRelay && isContentTypeError(e)) {
            logger.info('[ai-chat] 直连被拒(接口要求 Content-Type: application/json), 自动改用通用代理重试');
            data = await send(true);
            _transport = 'relay';
        } else {
            throw e;
        }
    }
    const choice = (data.choices && data.choices[0]) || {};
    const message = choice.message || {};
    let content = message.content;
    if (Array.isArray(content)) {
        // 某些接口会把 content 返回成分段数组
        content = content.map(function (c) {
            if (typeof c === 'string') return c;
            return (c && (c.text || c.content)) || '';
        }).join('');
    }
    return {
        // 源头就清掉思维链残留(否则可能泄漏到群里, 或跑进工具参数里)
        content: humanize.stripArtifacts(content === null || content === undefined ? '' : String(content)),
        toolCalls: normalizeToolCalls(message),
        finishReason: choice.finish_reason || '',
        usage: data.usage || null,
        raw: data
    };
}

/**
 * 带工具调用循环的对话。
 *
 * @param {object} opts
 * @param {Array}  opts.messages    初始消息列表 (含 system)
 * @param {Array}  opts.tools       OpenAI 格式工具定义
 * @param {number} opts.maxRounds   最多工具调用轮数
 * @param {Function} opts.onToolCall (name, args, result, ms) => void  观察者, 用于日志
 * @returns {Promise<{content: string, toolCalls: Array, rounds: number, usage: any}>}
 */
async function chatWithTools(opts) {
    const cfg = config.llm();
    const maxRounds = Math.max(0, Number(opts.maxRounds === undefined ? cfg.maxToolRounds : opts.maxRounds) || 0);
    const messages = opts.messages.slice();
    const tools = opts.tools || [];
    const registry = opts.registry || null;
    const used = [];
    let usageTotal = null;
    let content = '';
    let rounds = 0;

    for (let round = 0; round <= maxRounds; round++) {
        const res = await chatOnce({
            messages: messages,
            tools: tools.length ? tools : [],
            model: opts.model,
            temperature: opts.temperature,
            maxTokens: opts.maxTokens
        });
        if (res.usage) usageTotal = res.usage;
        content = res.content;

        if (!res.toolCalls.length || !registry) {
            return { content: content, toolCalls: used, rounds: rounds, usage: usageTotal };
        }

        // 把 assistant 的 tool_calls 原样写回历史, 否则部分接口会报错
        const assistantMsg = { role: 'assistant', content: content || '' };
        if (cfg.apiStyle === 'functions') {
            const first = res.toolCalls[0];
            assistantMsg.function_call = { name: first.name, arguments: first.arguments };
        } else {
            assistantMsg.tool_calls = res.toolCalls.map(function (tc) {
                return {
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : util.safeStringify(tc.arguments) }
                };
            });
        }
        messages.push(assistantMsg);

        for (let i = 0; i < res.toolCalls.length; i++) {
            const tc = res.toolCalls[i];
            const started = util.now();
            let resultText;
            try {
                const args = typeof tc.arguments === 'string' ? util.safeJson(tc.arguments, {}) : (tc.arguments || {});
                const value = await registry.invoke(tc.name, args, opts.context);
                resultText = typeof value === 'string' ? value : util.safeStringify(value);
            } catch (e) {
                resultText = JSON.stringify({ error: String((e && e.message) || e) });
            }
            resultText = util.truncate(resultText, Number(config.get().tools.maxResultChars) || 3000);
            used.push({ name: tc.name, arguments: tc.arguments, result: resultText });
            if (typeof opts.onToolCall === 'function') {
                try { opts.onToolCall(tc.name, tc.arguments, resultText, util.now() - started); } catch (e) { /* ignore */ }
            }
            if (cfg.apiStyle === 'functions') {
                messages.push({ role: 'function', name: tc.name, content: resultText });
            } else {
                messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
            }
        }
        rounds++;
    }

    // 工具轮数用尽, 再要一次纯文本总结
    const finalRes = await chatOnce({ messages: messages, tools: [], model: opts.model, maxTokens: opts.maxTokens });
    return { content: finalRes.content, toolCalls: used, rounds: rounds, usage: usageTotal };
}

/**
 * 简单摘要调用 (用于长期记忆抽取 / WebUI 测试)
 * @returns {Promise<string>}
 */
async function complete(prompt, systemPrompt, opts) {
    opts = opts || {};
    const cfg = config.llm();
    const model = opts.model || cfg.summaryModel || cfg.model;
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const res = await chatOnce({
        messages: messages,
        model: model,
        temperature: opts.temperature === undefined ? 0.3 : opts.temperature,
        maxTokens: opts.maxTokens || 400,
        timeoutMs: opts.timeoutMs
    });
    return res.content;
}

/**
 * 从对话片段里抽取长期记忆 (返回字符串数组)
 */
async function extractFacts(transcript, personaName) {
    const system = '你是一个记忆抽取器。请从对话中抽取关于用户的重要事实(称呼、身份、喜好、约定、正在做的事等)。' +
        '只输出 JSON 数组, 例如 ["用户叫小明","用户喜欢红石","用户是服主"]。' +
        '没有值得记住的内容就输出 []。每条不超过 40 字, 最多 3 条, 不要输出解释。';
    const text = await complete('机器人名字: ' + (personaName || '助手') + '\n对话:\n' + transcript, system, {
        temperature: 0.2, maxTokens: 300
    });
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const arr = util.safeJson(cleaned, null);
    if (Array.isArray(arr)) {
        return arr.map(function (x) { return util.trim(typeof x === 'string' ? x : (x && x.text) || ''); })
            .filter(Boolean).slice(0, 3);
    }
    // 退化处理: 按行拆
    return cleaned.split('\n').map(function (s) { return util.trim(s.replace(/^[-*\d.\s]+/, '')); })
        .filter(function (s) { return s.length > 1 && s.length < 60; }).slice(0, 3);
}

module.exports = {
    viaRelay: viaRelay,
    transportName: transportName,
    resetTransport: function () { _transport = null; },
    inCooldown: inCooldown,
    clearCooldown: clearCooldown,
    cooldownLeftMs: cooldownLeftMs,
    setCooldown: setCooldown,
    endpoint: endpoint,
    chatOnce: chatOnce,
    chatWithTools: chatWithTools,
    complete: complete,
    extractFacts: extractFacts,
    normalizeToolCalls: normalizeToolCalls
};
