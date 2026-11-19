'use strict';

/**
 * 拟人化模块。
 *
 * 做的事情:
 *   1. 清洗模型输出里的 Markdown / 舞台提示
 *   2. 把一条长回复拆成"像真人连续发的几条短消息"
 *   3. 计算打字延迟与每条消息之间的间隔
 *   4. 随机决定要不要引用、要不要 @ 对方、要不要加个表情
 */

const util = require('./util.js');
const config = require('./config.js');

/** 去掉 Markdown 与模型常见的"自说自话"包装 */
/**
 * 去掉模型泄漏出来的"思考过程"标记。
 *
 * 实测: 推理类模型有时把思维链标签漏进正文, 群里就会看到孤零零一个 `</think>`。
 * 这里先整块删掉 <think>…</think>, 再删掉落单的开/闭标签, 最后套用管理员自定义的正则。
 */
const THINK_TAGS = 'think|thinking|reasoning|reason|analysis|scratchpad|thought|reflection';

function stripArtifacts(text, builtinOnly) {
    let s = String(text === null || text === undefined ? '' : text);

    // 1) 整块思考内容
    s = s.replace(new RegExp('<\\s*(' + THINK_TAGS + ')\\b[^>]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>', 'gi'), '');
    // 2) 落单的开/闭标签(常见于上游已把思考内容裁掉、只留下闭合标签)
    s = s.replace(new RegExp('<\\s*/?\\s*(?:' + THINK_TAGS + ')\\b[^>]*>', 'gi'), '');
    // 3) 其它常见残留
    s = s.replace(/<\|?\s*(?:end_of_thinking|start_of_thinking|end_of_text)\s*\|?>/gi, '');
    s = s.replace(/\[\[?\s*(?:思考|thinking)\s*\]?\]/gi, '');
    // 4) 管理员自定义正则(每行一条, 全局替换为空)
    const raw = builtinOnly ? '' : util.trim((config.get().humanize || {}).stripRegex);
    if (raw) {
        raw.split(/\r?\n/).forEach(function (line) {
            const t = util.trim(line);
            if (!t || t[0] === '#') return;
            try {
                s = s.replace(new RegExp(t, 'gi'), '');
            } catch (e) {
                try { logger.warning('[ai-chat] 自定义过滤正则无效, 已跳过: {0}', t); } catch (x) { }
            }
        });
    }
    return s;
}

function stripMarkdown(text) {
    let s = stripArtifacts(String(text === null || text === undefined ? '' : text));
    s = s.replace(/```[\s\S]*?```/g, function (m) { return m.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, ''); });
    s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');            // 标题
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');              // 粗体
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');      // 斜体
    s = s.replace(/`([^`]+)`/g, '$1');                    // 行内代码
    s = s.replace(/^\s*[-*+]\s+/gm, '');                  // 列表符号
    s = s.replace(/^\s*\d+[.、)]\s+/gm, '');              // 有序列表
    s = s.replace(/^\s*>\s?/gm, '');                      // 引用
    s = s.replace(/^\s*[（(](?:思考|内心|旁白|动作)[^）)]*[）)]\s*$/gm, '');
    s = s.replace(/\[(?:表情|图片|SKIP|skip)\]/g, '');
    // QQ 消息支持换行, 但"空行"只会显示成一个多余的回车 —— 折叠掉。
    // (原来只折叠 3 个以上换行, 于是模型输出的 `第一句\n\n第二句` 中间就留了个空行)
    s = s.replace(/[ \t]+\n/g, '\n');     // 行尾空格
    s = s.replace(/\n{2,}/g, '\n');        // 连续空行 -> 单换行
    return s.trim();
}

/** 是否表示"这次不回复" */
function isSkip(text, token) {
    const s = util.trim(text);
    if (!s) return true;
    const t = util.trim(token || '[SKIP]');
    if (s === t || s.toUpperCase() === t.toUpperCase()) return true;
    if (s.length <= 8 && /^[（(\[【]?\s*(skip|跳过|不回|不说话|保持沉默|沉默)\s*[)）\]】]?$/i.test(s)) return true;
    return false;
}

/** 在标点/换行处把长文本切成不超过 maxChars 的块 */
/**
 * 把文本切成"要分几条发"的片段。
 *
 * ★ 关键: 模型自己写的**换行就是分段意图** —— 它用换行排版成"几句聊天"，
 *   所以默认一行 = 一条消息发送（之前只有当累计长度超过 maxChars 才断开，
 *   于是 4 行短句被拼成了一条消息）。
 *   单行超过 maxChars 时, 才再按句末标点拆一次, 仍然超长就硬切。
 *
 * @param {string} text
 * @param {number} maxChars 单条最大字数
 * @param {boolean} splitOnNewline 是否"换行即分段"(默认 true)
 */
function segment(text, maxChars, splitOnNewline) {
    const max = Math.max(4, Number(maxChars) || 120);   // plan() 里已经做过 20~2000 的收敛
    const raw = String(text === null || text === undefined ? '' : text);
    const out = [];

    const lines = (splitOnNewline === false)
        ? [raw.replace(/\s*\n\s*/g, ' ').trim()]                 // 不按换行分段: 换行当空格
        : raw.split(/\n+/).map(function (x) { return x.trim(); });  // 换行即分段

    lines.filter(Boolean).forEach(function (line) {
        if (line.length <= max) { out.push(line); return; }
        // 太长: 先按句末标点拆
        const parts = line.split(/(?<=[。！？!?…~～;；])/).filter(function (x) { return x.trim(); });
        let buf = '';
        parts.forEach(function (p) {
            if ((buf + p).length <= max) { buf += p; }
            else { if (buf) out.push(buf.trim()); buf = p; }
        });
        if (buf.trim()) out.push(buf.trim());
        // 还是超长就硬切
        const fixed = [];
        out.forEach(function (c) {
            let r = c;
            while (r.length > max) { fixed.push(r.slice(0, max)); r = r.slice(max); }
            if (r) fixed.push(r);
        });
        out.length = 0;
        fixed.forEach(function (x) { out.push(x); });
    });
    return out.filter(function (x) { return x && x.trim(); });
}

/** 兼容旧调用: 按标点+长度切分(不再单独用于主流程) */
function splitByPunctuation(text, maxChars) {
    return segment(text, maxChars, false);
}

function mergeTiny(chunks, minLen) {
    const out = [];
    chunks.forEach(function (c) {
        if (out.length && c.length < (minLen || 6) && !/[\n]$/.test(out[out.length - 1])) {
            out[out.length - 1] = out[out.length - 1] + c;
        } else {
            out.push(c);
        }
    });
    return out;
}

/**
 * 规划一次回复的发送方式
 * @param {string} text 模型输出
 * @param {object} opts { senderId, messageId, isGroup }
 * @returns {{skipped: boolean, segments: Array, delay: number}|{skipped: true}}
 */
/**
 * ★ 去掉 emoji 和 QQ 表情代码，但【保留颜文字】✓
 *   emoji: 1F000-1FAFF(表情) / 2600-27BF(杂项符号) / FE0F(变体选择符) / 200D(零宽连接) / 20E3(键帽)
 *   QQ 表情代码: [流泪] [捂脸] [呲牙] …
 *   颜文字用的字符(・ω・´∀≧▽･•◕ 等)都不在上面这些区间里, 不会被误删 ✓
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const QQ_FACES = ['微笑','撇嘴','色','发呆','得意','流泪','害羞','闭嘴','睡','大哭','尴尬','发怒','调皮','呲牙',
    '惊讶','难过','酷','冷汗','抓狂','吐','偷笑','可爱','白眼','傲慢','饥饿','困','惊恐','流汗','憨笑','悠闲',
    '奋斗','咒骂','疑问','嘘','晕','折磨','衰','骷髅','敲打','再见','擦汗','抠鼻','鼓掌','糗大了','坏笑',
    '左哼哼','右哼哼','哈欠','鄙视','委屈','快哭了','阴险','亲亲','吓','可怜','菜刀','西瓜','啤酒','篮球',
    '乒乓','咖啡','饭','猪头','玫瑰','凋谢','示爱','爱心','心碎','蛋糕','闪电','炸弹','刀','足球','瓢虫',
    '便便','月亮','太阳','礼物','拥抱','强','弱','握手','胜利','抱拳','勾引','拳头','差劲','爱你','NO','OK',
    '爱情','飞吻','跳跳','发抖','怄火','转圈','磕头','回头','跳绳','挥手','激动','街舞','献吻','左太极','右太极'];
const QQ_FACE_RE = new RegExp('\\[(' + QQ_FACES.join('|') + ')\\]', 'g');

function stripEmoji(text) {
    let t = String(text || '');
    try { t = t.replace(EMOJI_RE, ''); } catch (e) { }
    t = t.replace(QQ_FACE_RE, '');
    // 清掉删完留下的多余空格 / 空括号
    return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function plan(text, opts) {
    opts = opts || {};
    const h = config.get().humanize;
    const clean = stripEmoji(stripMarkdown(text));   // ★ 去掉 emoji/QQ表情, 保留颜文字 ✓
    if (!clean) return { skipped: true, segments: [], delay: 0, reason: '内容为空' };
    if (isSkip(clean, config.get().behavior.skipToken)) return { skipped: true, segments: [], delay: 0 };

    let chunks = [clean];
    if (h.enabled && h.multiSegment) {
        const maxChars = util.clamp(h.segmentMaxChars, 20, 2000);
        const splitOnNewline = h.splitOnNewline !== false;
        chunks = segment(clean, maxChars, splitOnNewline);
        // 换行切出来的片段是模型的"分段意图", 不再合并; 按长度硬切出来的才合并过短的
        if (!splitOnNewline) chunks = mergeTiny(chunks, 6);
        const maxCount = util.clamp(h.segmentMaxCount, 1, 10);
        if (chunks.length > maxCount) {
            const head = chunks.slice(0, maxCount - 1);
            head.push(chunks.slice(maxCount - 1).join('\n'));   // 超出上限的合并成一条(用换行保留可读性)
            chunks = head;
        }
    }

    // 延迟计算
    const typing = h.enabled
        ? util.clamp(Number(h.typingBaseMs) + clean.length * Number(h.typingPerCharMs) + util.randInt(0, Number(h.typingJitterMs) || 0),
            0, Number(h.typingMaxMs) || 6000)
        : 0;

    const segments = chunks.map(function (c, i) {
        let delayBefore = 0;
        if (i > 0 && h.enabled) {
            delayBefore = util.clamp(
                Number(h.segmentDelayBaseMs) + c.length * Number(h.segmentDelayPerCharMs) + util.randInt(0, Number(h.segmentDelayJitterMs) || 0),
                0, 8000
            );
        }
        return {
            text: c,
            delayBefore: delayBefore,
            quote: !!(h.enabled && i === 0 && opts.isGroup && opts.messageId) && util.chance(h.quoteChance),
            at: !!(h.enabled && i === 0 && opts.isGroup && opts.senderId) && util.chance(h.atChance),
            emoji: h.enabled && util.chance(h.emojiChance) ? util.pick(h.emojiIds) : null
        };
    });

    return { skipped: false, segments: segments, delay: typing };
}

/** 供日志/UI 展示的预览 */
function preview(segments) {
    return (segments || []).map(function (s) { return s.text; }).join(' | ');
}

module.exports = {
    stripEmoji: stripEmoji,
    stripMarkdown: stripMarkdown,
    segment: segment,
    stripArtifacts: stripArtifacts,
    isSkip: isSkip,
    splitByPunctuation: splitByPunctuation,
    plan: plan,
    preview: preview
};
