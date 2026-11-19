'use strict';

/**
 * 极小的 ZIP 写入器(零依赖) —— 只为本仓库的发布脚本服务。
 *
 * 为什么不调 `zip` 命令:
 *   发布流程不该依赖执行环境装没装 zip/unzip; Node 有 zlib, 自己写 100 行就够 ✓
 * 为什么不用 npm 包:
 *   发布脚本要在"刚 clone 下来、什么都没装"的环境里也能跑 ✓
 *
 * 用法:
 *   const Zip = require('./zip.js');
 *   const z = new Zip();
 *   z.add('manifest.json', Buffer.from('...'));
 *   z.write('/path/out.zip');
 */

const zlib = require('zlib');

// ---- CRC32(标准多项式 0xEDB88320) ----
const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** MS-DOS 时间格式(用当前时间即可, 只影响解压时显示的时间戳) */
function dosTime(d) {
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xFFFF;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
    return { time: time, date: date };
}

class Zip {
    constructor() {
        this._entries = [];   // { name, crc, comp, raw, method, offset }
        this._parts = [];     // 数据块, 最后 join 一次写出
        this._offset = 0;
    }

    /** 添加一个文件。name 用 / 分隔, 不要以 / 开头(市场要求 manifest.json 在根部) */
    add(name, buf) {
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
        name = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
        if (!name) throw new Error('zip: 文件名为空');
        if (/\.\./.test(name)) throw new Error('zip: 文件名里不能有 .. : ' + name);

        const raw = buf;
        const crc = crc32(raw);
        // 只有"压得动"的文件才用 deflate(小文件压了反而更大)
        let comp = zlib.deflateRawSync(raw, { level: 9 });
        let method = 8;
        if (comp.length >= raw.length) { comp = raw; method = 0; }

        // ★ 固定时间戳 -> 同样的内容永远生成同样的 zip(md5 可复现, 便于核对发布包) ✓
        //   (用当前时间的话, 每次打包 md5 都不一样, 就没法校验"这个包是不是这个版本" ✗)
        const d = { time: 0, date: ((2026 - 1980) << 9) | 1 };
        const nameBuf = Buffer.from(name, 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);       // 本地文件头签名
        local.writeUInt16LE(20, 4);               // 需要的版本
        local.writeUInt16LE(0x0800, 6);           // 标志位: 文件名 UTF-8
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(d.time, 10);
        local.writeUInt16LE(d.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(comp.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);               // 扩展字段长度

        this._entries.push({ name: nameBuf, crc: crc, comp: comp.length, raw: raw.length, method: method, offset: this._offset, date: d });
        this._parts.push(local, nameBuf, comp);
        this._offset += local.length + nameBuf.length + comp.length;
        return this;
    }

    names() { return this._entries.map(function (e) { return e.name.toString('utf8'); }); }
    count() { return this._entries.length; }

    /** 生成完整 zip 的 Buffer */
    toBuffer() {
        const parts = this._parts.slice();
        const cdStart = this._offset;
        let cdSize = 0;
        const self = this;
        this._entries.forEach(function (e) {
            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0);      // 中央目录签名
            cd.writeUInt16LE(20, 4);              // 创建版本
            cd.writeUInt16LE(20, 6);              // 需要版本
            cd.writeUInt16LE(0x0800, 8);          // 标志位 UTF-8
            cd.writeUInt16LE(e.method, 10);
            cd.writeUInt16LE(e.date.time, 12);
            cd.writeUInt16LE(e.date.date, 14);
            cd.writeUInt32LE(e.crc, 16);
            cd.writeUInt32LE(e.comp, 20);
            cd.writeUInt32LE(e.raw, 24);
            cd.writeUInt16LE(e.name.length, 28);
            cd.writeUInt16LE(0, 30);              // 扩展字段
            cd.writeUInt16LE(0, 32);              // 注释
            cd.writeUInt16LE(0, 34);              // 磁盘号
            cd.writeUInt16LE(0, 36);              // 内部属性
            cd.writeUInt32LE(0, 38);              // 外部属性
            cd.writeUInt32LE(e.offset, 42);
            parts.push(cd, e.name);
            cdSize += cd.length + e.name.length;
        });

        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);        // EOCD 签名
        eocd.writeUInt16LE(0, 4);
        eocd.writeUInt16LE(0, 6);
        eocd.writeUInt16LE(self._entries.length, 8);
        eocd.writeUInt16LE(self._entries.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        eocd.writeUInt16LE(0, 20);                // 注释长度
        parts.push(eocd);

        return Buffer.concat(parts);
    }

    write(outPath) {
        require('fs').writeFileSync(outPath, this.toBuffer());
        return outPath;
    }
}

module.exports = Zip;
module.exports.crc32 = crc32;
