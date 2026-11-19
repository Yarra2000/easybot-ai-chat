/**
 * 通过 EasyBot 的 bridge 读取玩家存档数据(含**离线**玩家)。
 *
 * 原理(实测确认):
 *   玩家名 → db.GetPlayerByName → UUID
 *        → bridge.ReadNbtData(uuid, NbtDataType)   // 0=PlayerData 1=Advancements 2=Statistics
 *        → 服务端模组读 world/playerdata/<uuid>.dat (离线 NBT) 并回传 JSON
 *
 * interop 要点(踩过的坑):
 *   - 返回包的 pkt.Data 是 .NET 对象: JSON.stringify 得 {}、String() 得 "[object Object]"，
 *     必须用 **pkt.Data.ToString()** 才拿到真正的 JSON 字符串。
 *   - 有多个服务器时, 玩家的 UUID 只属于其中一台 —— 逐个 bridge 试, 取第一个有数据的。
 */
const util = require('./util.js');
const logger = require('./util.js').logger || null;

const KINDS = { playerdata: 'PlayerData', inventory: 'PlayerData', advancements: 'Advancements', achievement: 'Advancements', stats: 'Statistics', statistics: 'Statistics' };

// 枚举类型 EasyBot.Bridge.Packet.Client.NbtDataType 在宿主程序集里,
// 直接传数字只有 0 能过重载匹配, 所以用反射找到类型再 Enum.Parse 出真正的枚举值。
let _enumType = null, _enumErr = '';
function nbtEnumType() {
    if (_enumType || _enumErr) return _enumType;
    try {
        const Sys = Function('return (typeof dotnet !== "undefined") ? dotnet.System : null')();
        const asms = [];
        try { asms.push.apply(asms, util.toArray(Sys.AppDomain.CurrentDomain.GetAssemblies())); } catch (e) { }
        if (Sys.Reflection.Assembly.GetEntryAssembly) {
            try { asms.push(Sys.Reflection.Assembly.GetEntryAssembly()); } catch (e) { }
        }
        for (let i = 0; i < asms.length; i++) {
            try {
                const t = asms[i] && asms[i].GetType ? asms[i].GetType('EasyBot.Bridge.Packet.Client.NbtDataType') : null;
                if (t) { _enumType = t; break; }
            } catch (e) { }
        }
        if (!_enumType) _enumErr = '找不到 NbtDataType 枚举类型';
    } catch (e) { _enumErr = String((e && e.message) || e); }
    return _enumType;
}

/** 把 'PlayerData' 这样的名字转成真正的枚举值 */
function nbtEnumValue(name) {
    const t = nbtEnumType();
    if (!t) return name;   // 退而求其次: 直接传字符串(某些版本可用)
    try {
        const Sys = Function('return dotnet.System')();
        return Sys.Enum.Parse(t, String(name));
    } catch (e) {
        return name;
    }
}

/** 枚举的全部取值(诊断用) */
function nbtEnumNames() {
    const t = nbtEnumType();
    if (!t) return _enumErr;
    try {
        const Sys = Function('return dotnet.System')();
        return util.toArray(Sys.Enum.GetNames(t)).join(',');
    } catch (e) { return '读枚举名失败: ' + String((e && e.message) || e); }
}

/** 把 pkt.Data 里的 JSON 取出来并解析 */
function dataOf(pkt) {
    if (!pkt) return null;
    let d = null;
    try { d = pkt.Data; } catch (e) { return null; }
    if (d === undefined || d === null) return null;
    let raw = '';
    if (typeof d === 'string') raw = d;
    else {
        try { raw = String(d.ToString()); } catch (e) { raw = ''; }
        if (!raw || raw === '[object Object]' || raw === '{}') {
            try { raw = util.safeStringify(d) || ''; } catch (e) { raw = ''; }
        }
    }
    if (!raw || raw === '[object Object]') return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

/** 玩家名 -> UUID (用 EasyBot 的玩家库) */
function resolveUuid(name) {
    try {
        const p = db.GetPlayerByName(String(name));
        if (!p) return '';
        return String(p.Uuid || p.UUID || p.uuid || '');
    } catch (e) {
        return '';
    }
}

/**
 * 读某个玩家的 NBT 数据。
 *
 * ★ 注意: UUID 是**账号级**的, 同一账号在多个服务器都有存档, 但各服数据完全不同
 *   (实测: 有的服背包满、末影箱空; 有的服正相反)。
 *   所以这里**把所有服务器的结果都收集起来**, 由调用方按 server 选择。
 *
 * @param {string} name 玩家名
 * @param {string} kind playerdata/inventory | advancements | stats
 * @param {string} server 可选: 服务器名(模糊匹配)
 */
async function read(name, kind, server) {
    const typeName = KINDS[String(kind || 'playerdata').toLowerCase()];
    if (typeName === undefined) return { ok: false, error: '不支持的类型: ' + kind };
    const type = nbtEnumValue(typeName);
    const uuid = resolveUuid(name);
    if (!uuid) {
        return {
            ok: false, uuid: '', error: '查不到玩家 "' + name + '" 的 UUID',
            hint: '该玩家可能从未进过服务器, 或后台手动建的记录没关联真实 UUID'
        };
    }
    let bridges = [];
    try { bridges = util.toArray(sessions.GetBridges()); } catch (e) { }
    if (!bridges.length) return { ok: false, uuid: uuid, error: '当前没有已连接的 MC 服务器' };

    const found = [], tried = [];
    for (let i = 0; i < bridges.length; i++) {
        const b = bridges[i];
        let sname = '服务器' + (i + 1);
        try { sname = String((b.Session && b.Session.Info && b.Session.Info.CachedServerName) || sname); } catch (e) { }
        try {
            const pkt = await b.ReadNbtData(uuid, type);
            const msg = (function () { try { return String(pkt.Message || ''); } catch (e) { return ''; } })();
            const data = dataOf(pkt);
            tried.push(sname + ':' + msg + (data ? '(有数据)' : '(空)'));
            if (data) found.push({ server: sname, data: data });
        } catch (e) {
            tried.push(sname + ':错误 ' + String((e && e.message) || e).slice(0, 60));
        }
    }
    if (!found.length) {
        // 把模组的原话带出来, 并区分"没数据"和"模组不支持这类数据"
        const unsupported = tried.some(function (t) { return t.indexOf('不知道你提供的数据类型') >= 0; });
        return {
            ok: false, uuid: uuid, tried: tried,
            error: unsupported
                ? ('当前模组不支持「' + typeName + '」这类数据 (需要更新服务端模组)')
                : '没有服务器返回该玩家的数据',
            unsupported: unsupported
        };
    }

    const want = util.trim(server).toLowerCase();
    let chosen = found[0];
    if (want) {
        const hit = found.filter(function (x) { return x.server.toLowerCase().indexOf(want) >= 0; })[0];
        if (!hit) {
            return {
                ok: false, uuid: uuid, tried: tried,
                error: '该玩家在 "' + server + '" 没有数据',
                availableServers: found.map(function (x) { return x.server; })
            };
        }
        chosen = hit;
    }
    return {
        ok: true, uuid: uuid, kind: String(kind || 'playerdata'),
        server: chosen.server, data: chosen.data,
        allServers: found.map(function (x) { return x.server; }),
        tried: tried
    };
}

// ---------------------------------------------------------------- 摘要(给模型看的, 要短)

function shortId(id) {
    return String(id || '?').replace(/^minecraft:/, '');
}

function slotName(slot) {
    if (slot === undefined || slot === null) return '';
    const s = Number(slot);
    if (s >= 0 && s <= 8) return '快捷栏' + (s + 1);
    if (s >= 9 && s <= 35) return '背包' + (s - 8);
    if (s === 36) return '靴子';
    if (s === 37) return '护腿';
    if (s === 38) return '胸甲';
    if (s === 39) return '头盔';
    if (s === 40) return '副手';
    return '槽' + s;
}

function itemLine(it) {
    if (!it) return '';
    const id = shortId(it.id || it.Id);
    let n = 1;
    try { n = Number(it.Count !== undefined ? it.Count : (it.count !== undefined ? it.count : 1)) || 1; } catch (e) { n = 1; }
    let extra = '';
    try {
        const tag = it.tag || it.Tag;
        if (tag) {
            const dmg = tag.Damage !== undefined ? Number(tag.Damage) : null;
            const name = tag.display && (tag.display.Name || (tag.display.Name && tag.display.Name.text));
            if (name) extra += ' 「' + String(name).slice(0, 20) + '」';
            if (dmg) extra += ' (耐久-' + dmg + ')';
            const ench = tag.Enchantments;
            if (ench && Object.keys(ench).length) extra += ' [附魔x' + Object.keys(ench).length + ']';
        }
    } catch (e) { }
    return id + ' x' + n + (extra ? extra : '');
}

/**
 * 把一件物品"一次性"读成普通 JS 对象。
 *
 * ★ 必须一次读完: 这些 NBT 节点是 .NET 对象, 同一个属性**读第二次就会变**
 *   (亲眼见过 Count 第一次读是 64、再读变成 1), 分散读取会算出完全错误的数量。
 */
function extractItem(it) {
    const o = { id: '?', count: 1, slot: null, extra: '' };
    if (!it) return o;
    try { const v = (it.id !== undefined) ? it.id : it.Id; if (v !== undefined) o.id = shortId(v); } catch (e) { }
    try {
        const c = (it.Count !== undefined) ? it.Count : it.count;
        if (c !== undefined && c !== null) { const n = Number(c); if (!isNaN(n) && n > 0) o.count = n; }
    } catch (e) { }
    try {
        const sl = (it.Slot !== undefined) ? it.Slot : it.slot;
        if (sl !== undefined && sl !== null) { const n = Number(sl); if (!isNaN(n)) o.slot = n; }
    } catch (e) { }
    try {
        const tag = it.tag || it.Tag;
        if (tag) {
            let nm = '';
            try { const dp = tag.display; if (dp) { const n2 = dp.Name; if (typeof n2 === 'string') nm = n2; else if (n2 && n2.text) nm = String(n2.text); } } catch (e) { }
            if (nm) o.extra += ' 「' + String(nm).slice(0, 20) + '」';
            try { const dmg = tag.Damage; if (dmg !== undefined && Number(dmg) > 0) o.extra += ' (耐久-' + Number(dmg) + ')'; } catch (e) { }
            try { const en = tag.Enchantments; const ks = en ? Object.keys(en) : []; if (ks.length) o.extra += ' [附魔x' + ks.length + ']'; } catch (e) { }
        }
    } catch (e) { }
    return o;
}

function lineOf(x) { return x.id + ' x' + x.count + (x.extra || ''); }

/** 同 id 合并计数, 按数量倒序 */
function aggregate(items) {
    const map = {};
    (items || []).forEach(function (x) {
        if (!map[x.id]) map[x.id] = { id: x.id, count: 0, stacks: 0, extra: '' };
        map[x.id].count += x.count;
        map[x.id].stacks += 1;
        if (!map[x.id].extra && x.extra) map[x.id].extra = x.extra;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
        .sort(function (a, b) { return b.count - a.count; });
}

function aggLine(x) {
    return x.id + ' x' + x.count + (x.stacks > 1 ? '(' + x.stacks + '组)' : '') + (x.extra || '');
}

/** 背包 + 装备 + 末影箱 */
function summarizeInventory(d, maxItems) {
    const cap = Math.max(5, Number(maxItems) || 60);
    const out = { items: [], slots: [], count: 0, distinct: 0, totalItems: 0, enderChest: [], enderCount: 0, enderDistinct: 0, equipment: {}, vitals: {} };

    // ★ 先一次性读成普通对象, 后面全用普通对象算
    const inv = util.toArray(d.Inventory || d.inventory || []).map(extractItem);
    out.count = inv.length;
    const aggInv = aggregate(inv);
    out.distinct = aggInv.length;
    out.totalItems = aggInv.reduce(function (a, x) { return a + x.count; }, 0);
    out.items = aggInv.slice(0, cap).map(aggLine);
    inv.forEach(function (x) {
        if (x.slot !== null && x.slot >= 36 && x.slot <= 40) out.slots.push(slotName(x.slot) + '=' + lineOf(x));
    });

    const ec = util.toArray(d.EnderItems || d.enderItems || []).map(extractItem);
    out.enderCount = ec.length;
    const aggEc = aggregate(ec);
    out.enderDistinct = aggEc.length;
    out.enderChest = aggEc.slice(0, cap).map(aggLine);

    // 1.21 的 equipment 字段
    try {
        const eq = d.equipment || d.Equipment;
        if (eq) {
            Object.keys(eq).forEach(function (k) {
                const x = extractItem(eq[k]);
                if (x.id !== '?') out.equipment[k] = lineOf(x);
            });
        }
    } catch (e) { }

    ['Health', 'foodLevel', 'XpLevel', 'XpTotal', 'playerGameType', 'Dimension', 'Score'].forEach(function (k) {
        try { if (d[k] !== undefined) out.vitals[k] = d[k]; } catch (e) { }
    });
    try { if (d.Pos !== undefined) out.vitals.Pos = d.Pos; } catch (e) { }
    return out;
}

/** 统计: 只挑人最关心的几项 */
function summarizeStats(d, maxItems) {
    const cap = Math.max(5, Number(maxItems) || 40);
    const root = d.stats || d.Stats || d;
    const rawCats = root['minecraft:custom'] || root.custom || {};
    // 新版 MC 的键带 minecraft: 前缀, 归一化后再映射
    const cats = {};
    try {
        Object.keys(rawCats).forEach(function (k) { cats[shortId(k)] = rawCats[k]; });
    } catch (e) { }
    const mined = root['minecraft:mined'] || root.mined || {};
    const killed = root['minecraft:killed'] || root.killed || {};
    const crafted = root['minecraft:crafted'] || root.crafted || {};
    const used = root['minecraft:used'] || root.used || {};

    const out = { highlights: {}, topMined: [], topKilled: [], topCrafted: [], topUsed: [] };
    const H = {
        play_time: '总游戏时长(ticks, 20=1秒)', play_one_minute: '游戏时长(分钟)',
        walk_one_cm: '走路(cm)', sprint_one_cm: '疾跑(cm)', fly_one_cm: '飞行(cm)',
        deaths: '死亡次数', mob_kills: '击杀生物', player_kills: '击杀玩家',
        jump: '跳跃次数', damage_dealt: '造成伤害', damage_taken: '受到伤害',
        leave_game: '退出游戏次数', time_since_death: '距上次死亡(ticks)'
    };
    Object.keys(H).forEach(function (k) { if (cats[k] !== undefined) out.highlights[H[k]] = cats[k]; });

    const top = function (src, n) {
        return Object.keys(src).map(function (k) { return [shortId(k), Number(src[k]) || 0]; })
            .sort(function (a, b) { return b[1] - a[1]; }).slice(0, n)
            .map(function (x) { return x[0] + ' x' + x[1]; });
    };
    out.topMined = top(mined, cap);
    out.topKilled = top(killed, Math.min(cap, 15));
    out.topCrafted = top(crafted, Math.min(cap, 15));
    out.topUsed = top(used, Math.min(cap, 15));
    return out;
}

/** 成就: 已完成的列表 */
function summarizeAdvancements(d, maxItems) {
    const cap = Math.max(5, Number(maxItems) || 80);
    const done = [];
    let total = 0;
    try {
        Object.keys(d).forEach(function (k) {
            const v = d[k];
            if (!v || typeof v !== 'object') return;
            total++;
            if (v.done === true) done.push(shortId(k));
        });
    } catch (e) { }
    return { totalEntries: total, doneCount: done.length, done: done.slice(0, cap) };
}

module.exports = {
    read: read,
    nbtEnumNames: nbtEnumNames,
    nbtEnumValue: nbtEnumValue,
    resolveUuid: resolveUuid,
    dataOf: dataOf,
    summarizeInventory: summarizeInventory,
    summarizeStats: summarizeStats,
    summarizeAdvancements: summarizeAdvancements,
    slotName: slotName,
    itemLine: itemLine
};
