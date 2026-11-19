'use strict';

/**
 * QQ <-> MC 玩家绑定查询。
 *
 * 为什么需要它:
 *   EasyBot 的 SendRunCommandAsync(playerName, command, ...) 里的 playerName 必须是**真实玩家**。
 *   官方文档明确写着「命令权限必须改为绑定账号的用户, 否则命令无法找到用户绑定的玩家账号」。
 *   实测传 'CONSOLE' 这种不存在的名字时, 服务器会给一个受限的指令树 ——
 *   `help`/`list`/`seed` 全报 "Unknown or incomplete command", 只有 say/me/tell 之类能过。
 *   传真实玩家名(尤其是请求者本人绑定的号)才正常, 而且权限由 MC 服务端自己判定, 更安全。
 */

const util = require('./util.js');

/**
 * 取数据库 API。
 * 注意: SDK 里的命名空间叫 **db** (declare namespace db), 不是 database。
 * 这里两个名字都试一下, 免得不同 build 有差异。
 */
function dbApi() {
    try {
        if (typeof db !== 'undefined' && db && typeof db.GetSocialAccount === 'function') return db;
    } catch (e) { /* ignore */ }
    try {
        if (typeof database !== 'undefined' && database && typeof database.GetSocialAccount === 'function') return database;
    } catch (e) { /* ignore */ }
    return null;
}

/** database API 是否可用 */
function available() {
    const db = dbApi();
    return !!(db && typeof db.GetSocialAccount === 'function');
}

/**
 * 查某个社交账号(QQ)绑定的 MC 玩家名
 * @param {string} senderId QQ 号
 * @param {string} [platform='qq']
 * @returns {string[]} 玩家名列表(可能多个)
 */
function boundPlayers(senderId, platform) {
    const out = [];
    const db = dbApi();
    const id = util.trim(String(senderId === null || senderId === undefined ? '' : senderId));
    if (!id || !db || typeof db.GetSocialAccount !== 'function') return out;
    try {
        const acc = db.GetSocialAccount(platform || 'qq', id);
        if (!acc) return out;
        const users = util.toArray(acc.Users);
        users.forEach(function (p) {
            if (!p) return;
            const name = util.trim(String(p.Name || p.name || ''));
            if (name && out.indexOf(name) < 0) out.push(name);
        });
    } catch (e) { /* ignore */ }
    return out;
}

/** 只取一个(第一个)绑定玩家名 */
function boundPlayerName(senderId, platform) {
    const list = boundPlayers(senderId, platform);
    return list.length ? list[0] : '';
}

module.exports = {
    available: available,
    boundPlayers: boundPlayers,
    boundPlayerName: boundPlayerName
};
