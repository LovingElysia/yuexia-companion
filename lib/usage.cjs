'use strict';
// Token 用量统计（状态卡用），只读本机日志：
//  · Codex：rollout-*.jsonl 里的 token_count 事件。total_token_usage 是会话累计值，同一次用量会重复记录，
//    所以按“累计值的增量”计数（与白龙桌宠 token_analytics 一致），不会重复。
//  · DSH：session.v4.jsonl.zstd 里 assistant/message 的 usage.totalTokens。
// 首次在后台分块扫描全部日志，之后只读新增部分；按天、按小时汇总，缓存在数据目录的 usage-cache.json。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { codexHome } = require('./codex.cjs');
const { dshHome, decodeFrames } = require('./dsh.cjs');

const VERSION = 2;
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hourKey = (t) => dayKey(t) + ' ' + pad(new Date(t).getHours());

function walk(dir, test, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, test, out);
    else if (test(e.name)) out.push(p);
  }
  return out;
}

class UsageStats {
  constructor({ dataDir, getSettings, log = () => {} }) {
    this.file = path.join(dataDir, 'usage-cache.json');
    this.getSettings = getSettings;
    this.log = log;
    this.cache = this.load();
    this.scanning = null;
  }

  load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (c.version === VERSION) return c;
    } catch {}
    return { version: VERSION, files: {} };
  }

  save() {
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.cache));
      try { fs.renameSync(this.file + '.tmp', this.file); } catch { fs.copyFileSync(this.file + '.tmp', this.file); fs.rmSync(this.file + '.tmp', { force: true }); }
    } catch {}
  }

  /** 增量扫描（同一时间只跑一次）。 */
  refresh() {
    if (!this.scanning) {
      this.scanning = this.scan().catch((e) => this.log('usage', 'scan failed: ' + e.message)).finally(() => { this.scanning = null; });
    }
    return this.scanning;
  }

  async scan() {
    const s = this.getSettings();
    const codex = codexHome(s.codex.home), dsh = dshHome(s.dsh.home);
    const codexFiles = [...walk(path.join(codex, 'sessions'), (n) => /^rollout-.*\.jsonl$/.test(n)), ...walk(path.join(codex, 'archived_sessions'), (n) => /^rollout-.*\.jsonl$/.test(n))];
    const dshFiles = walk(path.join(dsh, 'sessions'), (n) => n === 'session.v4.jsonl.zstd');
    const seen = new Set();
    // 归档会把同一个 rollout 移到 archived_sessions：按文件名去重
    for (const file of codexFiles) {
      const key = 'codex:' + path.basename(file);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.scanCodex(key, file);
    }
    for (const file of dshFiles) {
      const key = 'dsh:' + path.basename(path.dirname(file));
      seen.add(key);
      await this.scanDsh(key, file);
    }
    this.save();
  }

  entry(key, source) {
    return this.cache.files[key] || (this.cache.files[key] = { source, size: 0, offset: 0, prev: 0, days: {}, hours: {} });
  }

  add(e, time, tokens) {
    if (!(tokens > 0) || !Number.isFinite(time)) return;
    const d = dayKey(time), h = hourKey(time);
    e.days[d] = (e.days[d] || 0) + tokens;
    e.hours[h] = (e.hours[h] || 0) + tokens;
  }

  async scanCodex(key, file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const e = this.entry(key, 'codex');
    if (stat.size < e.offset) Object.assign(e, { offset: 0, prev: 0, days: {}, hours: {} });
    if (stat.size === e.offset) return;
    const handle = await fsp.open(file, 'r');
    try {
      let rest = '';
      while (e.offset < stat.size) {
        const length = Math.min(4 * 1024 * 1024, stat.size - e.offset);
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, e.offset);
        if (!bytesRead) break;
        const text = rest + buf.toString('utf8', 0, bytesRead);
        const cut = text.lastIndexOf('\n');
        if (cut < 0) { rest = text; e.offset += bytesRead; continue; }
        // 只保留完整的行；最后不完整的一行下次再读
        const complete = text.slice(0, cut);
        rest = '';
        e.offset += bytesRead - Buffer.byteLength(text.slice(cut + 1));
        for (const line of complete.split('\n')) {
          if (!line.includes('"token_count"')) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const total = o.payload?.info?.total_token_usage?.total_tokens;
          if (typeof total !== 'number') continue;
          if (total > e.prev) this.add(e, Date.parse(o.timestamp), total - e.prev);
          if (total !== e.prev) e.prev = total;
        }
        await new Promise((r) => setImmediate(r)); // 让出事件循环，扫描大日志时不卡界面
      }
    } finally {
      await handle.close();
    }
    e.size = stat.size;
  }

  async scanDsh(key, file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const e = this.entry(key, 'dsh');
    if (stat.size === e.size) return;
    // DSH 会话文件不大：变化时整份重算
    Object.assign(e, { days: {}, hours: {} });
    const { text } = decodeFrames(await fsp.readFile(file), true);
    for (const line of text.split('\n')) {
      if (!line.includes('"assistant/message"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      this.add(e, Number(o.time), Number(o.data?.usage?.totalTokens) || 0);
    }
    e.size = stat.size;
  }

  /** 汇总：source = codex | dsh | all。 */
  summary(source = 'codex', now = Date.now()) {
    const days = {}, hours = {};
    for (const e of Object.values(this.cache.files)) {
      if (source !== 'all' && e.source !== source) continue;
      for (const [d, n] of Object.entries(e.days)) days[d] = (days[d] || 0) + n;
      for (const [h, n] of Object.entries(e.hours)) hours[h] = (hours[h] || 0) + n;
    }
    const today = dayKey(now);
    const series = (count) => Array.from({ length: count }, (_, i) => {
      const d = dayKey(now - (count - 1 - i) * 86400000);
      return { day: d, tokens: days[d] || 0 };
    });
    const sorted = Object.keys(days).sort();
    let all = [];
    if (sorted.length) {
      // 全部：从第一天到今天，超过 30 天时合并成 30 段
      const first = new Date(sorted[0] + 'T00:00:00').getTime();
      const span = Math.max(1, Math.round((new Date(today + 'T00:00:00').getTime() - first) / 86400000) + 1);
      const step = Math.max(1, Math.ceil(span / 30));
      for (let i = 0; i < span; i += step) {
        let tokens = 0;
        for (let j = i; j < Math.min(span, i + step); j++) tokens += days[dayKey(first + j * 86400000)] || 0;
        all.push({ day: dayKey(first + i * 86400000), tokens });
      }
    }
    const last24 = Array.from({ length: 24 }, (_, i) => {
      const t = now - (23 - i) * 3600000;
      return { hour: new Date(t).getHours(), tokens: hours[hourKey(t)] || 0 };
    });
    const sum = (list) => list.reduce((n, x) => n + x.tokens, 0);
    return {
      source, today: days[today] || 0, total: Object.values(days).reduce((a, b) => a + b, 0),
      week: series(7), month: series(30), all, last24, weekTotal: sum(series(7)), monthTotal: sum(series(30)),
      scanning: !!this.scanning, at: now,
    };
  }
}

module.exports = { UsageStats, dayKey };
