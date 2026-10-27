'use strict';
// DeepSeek Harness 联动：直接只读 DSH 写在本机的会话日志（~/.dsh/sessions/<工作区>/session-*/session.v4.jsonl.zstd），
// 不需要安装 dsh-pet 插件，也不需要 DSH 开着网页服务。日志每追加一段就是一个独立的 zstd 帧，
// 这里按字节偏移只读新增的帧，取 turn/start、tool/call、turn/end、session/title 等生命周期事件；
// 不读取、不展示推理、工具参数和输出。子代理会话（delegationDepth > 0）不提醒。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_FILES = 8;
const RECENT_MS = 12 * 3600 * 1000;
const TAIL_BYTES = 512 * 1024;

function dshHome(configured) {
  return configured || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 把一段连续的 zstd 帧解成文本。帧之间按魔数切开；压缩数据里偶尔也会出现魔数，
 * 解压失败就把下一段并进来再试。返回 { text, consumed }：consumed 之后的内容留到下次。
 * 截断的帧解压时不一定报错（会返回半截内容），所以最后一段只有在 final（文件已停止增长）时才解；
 * 否则要等它后面出现下一帧，才能确认它已写完。
 */
function decodeFrames(buf, final = false) {
  const starts = [];
  for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
  if (!starts.length) return { text: '', consumed: 0 };
  if (final) starts.push(buf.length);
  const parts = [];
  let from = 0, consumed = starts[0];
  for (let k = 1; k < starts.length; k++) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(starts[from], starts[k])));
      from = k;
      consumed = starts[k];
    } catch {}
  }
  return { text: Buffer.concat(parts).toString('utf8'), consumed };
}

function toolLabel(name) {
  const tool = String(name || '').toLowerCase();
  if (/edit|write|patch|apply/.test(tool)) return '正在编辑文件';
  if (/pwsh|shell|bash|exec|command|run_code|terminal/.test(tool)) return '正在运行命令';
  if (/read|view|glob|grep|list|find/.test(tool)) return '正在读取文件';
  if (/web|search|fetch|browse/.test(tool)) return '正在查找资料';
  return '正在使用工具';
}

class DshSession {
  constructor(id) {
    this.id = id;
    this.title = 'DSH 会话';
    this.state = 'idle';
    this.label = '等待新的任务';
    this.done = true;
    this.subagent = false;
    this.updated = 0;
  }

  apply(record, historical) {
    const type = record && record.type;
    const data = record && record.data && typeof record.data === 'object' ? record.data : {};
    const events = [];
    const emit = (event) => { if (!historical && !this.subagent) events.push({ ...event, session: this.id, title: this.title, source: 'dsh' }); };
    const stamp = Number(record && record.time) || Date.now();
    if (type === 'session') {
      this.subagent = Number(record.delegationDepth) > 0;
      if (record.createdAt) this.updated = Number(record.createdAt) || this.updated;
    } else if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim()) this.title = data.title.trim().slice(0, 30);
    } else if (type === 'turn/start') {
      this.done = false; this.state = 'thinking'; this.label = '收到任务，正在思考'; this.updated = stamp;
      emit({ kind: 'start' });
    } else if (type === 'tool/call' && !this.done) {
      const label = toolLabel(data.name);
      this.state = 'working'; this.updated = stamp;
      if (label !== this.label) { this.label = label; emit({ kind: 'activity', label }); }
    } else if (type === 'assistant/message' && !this.done) {
      if (this.state !== 'working') { this.state = 'thinking'; this.label = '正在思考下一步'; }
      this.updated = stamp;
    } else if (/^approval\/(request|requested|ask|asked)$/.test(String(type)) && !this.done) {
      this.state = 'waiting'; this.label = '等待你的批准'; this.updated = stamp;
      emit({ kind: 'waiting' });
    } else if (type === 'turn/end') {
      if (this.done) return events;
      const reason = String(data.reason && data.reason.kind || 'completed');
      this.done = true; this.updated = stamp;
      if (reason === 'completed') { this.state = 'complete'; this.label = '任务已完成'; emit({ kind: 'complete' }); }
      else if (/abort|cancel|interrupt|stop/.test(reason)) { this.state = 'interrupted'; this.label = '任务已中断'; emit({ kind: 'abort' }); }
      else { this.state = 'interrupted'; this.label = '任务没有成功'; emit({ kind: 'error' }); }
    }
    return events;
  }

  view() {
    return { id: this.id, title: this.title, state: this.state, label: this.label, active: !this.done, updated: this.updated, subagent: this.subagent };
  }
}

/** 所有工作区下 12 小时内写过的会话日志，按修改时间倒序。 */
function recentSessions(home, now = Date.now()) {
  const root = path.join(home, 'sessions');
  const files = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const workspace of workspaces) {
    let sessions = [];
    try { sessions = fs.readdirSync(path.join(root, workspace)); } catch {}
    for (const name of sessions) {
      if (!name.startsWith('session-')) continue;
      const file = path.join(root, workspace, name, 'session.v4.jsonl.zstd');
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs <= RECENT_MS) files.push({ file, id: name, mtime: stat.mtimeMs, size: stat.size, born: stat.birthtimeMs });
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

class DshWatcher {
  constructor({ getSettings, onEvent, log = () => {} }) {
    this.getSettings = getSettings;
    this.onEvent = onEvent;
    this.log = log;
    this.files = new Map(); // file -> { offset, pending, session, historical }
    this.timer = null;
    this.lastScan = 0;
    this.status = 'off'; // off | starting | watching | missing
  }

  home() {
    return dshHome(this.getSettings().dsh.home);
  }

  start() {
    if (this.timer) return;
    this.files.clear();
    this.lastScan = 0;
    this.startedAt = Date.now();
    this.status = 'starting';
    this.poll();
    this.timer = setInterval(() => this.poll(), 1500);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.files.clear();
    this.status = 'off';
  }

  poll() {
    const now = Date.now();
    if (now - this.lastScan > 10000) {
      this.lastScan = now;
      const recent = recentSessions(this.home(), now);
      if (!recent) { this.status = 'missing'; return; }
      const keep = new Set(recent.map((r) => r.file));
      for (const file of this.files.keys()) if (!keep.has(file) && this.files.get(file).session.done) this.files.delete(file);
      for (const r of recent) {
        if (this.files.has(r.file)) continue;
        const fresh = r.born > this.startedAt + 1000;
        const entry = { offset: 0, pending: Buffer.alloc(0), session: new DshSession(r.id), historical: !fresh };
        // 旧会话：先读开头一段拿到会话头和标题，再从末尾一段开始建立当前状态
        if (!fresh && r.size > TAIL_BYTES) {
          this.readRange(r.file, entry, 0, Math.min(64 * 1024, r.size), (record) => record.type === 'session' || record.type === 'session/title');
          entry.offset = this.alignToFrame(r.file, r.size - TAIL_BYTES);
        }
        this.files.set(r.file, entry);
      }
      this.status = 'watching';
    }
    for (const [file, entry] of this.files) this.read(file, entry);
  }

  /** 从 offset 起找到下一个帧起点（截断读取时用）。 */
  alignToFrame(file, offset) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const i = buf.subarray(0, n).indexOf(MAGIC);
      return i === -1 ? offset : offset + i;
    } catch {
      return offset;
    }
  }

  readRange(file, entry, start, end, filter) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(end - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      for (const line of decodeFrames(buf.subarray(0, n), end >= this.sizeOf(file)).text.split('\n')) {
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (filter(record)) entry.session.apply(record, true);
      }
    } catch {}
  }

  sizeOf(file) {
    try { return fs.statSync(file).size; } catch { return -1; }
  }

  read(file, entry) {
    const size = this.sizeOf(file);
    if (size < 0) { this.files.delete(file); return; }
    if (size < entry.offset) { entry.offset = 0; entry.pending = Buffer.alloc(0); }
    let chunk = Buffer.alloc(0);
    if (size > entry.offset) {
      try {
        const fd = fs.openSync(file, 'r');
        const length = Math.min(size - entry.offset, 8 * 1024 * 1024);
        chunk = Buffer.alloc(length);
        const n = fs.readSync(fd, chunk, 0, length, entry.offset);
        fs.closeSync(fd);
        chunk = chunk.subarray(0, n);
        entry.offset += n;
      } catch {
        return;
      }
    } else if (!entry.pending.length) {
      entry.historical = false;
      return;
    }
    // 本轮没有新字节 = 写入方已停下，剩下的最后一帧可以当作完整的来解
    const buf = Buffer.concat([entry.pending, chunk]);
    const { text, consumed } = decodeFrames(buf, chunk.length === 0);
    entry.pending = buf.subarray(consumed);
    if (entry.pending.length > 8 * 1024 * 1024) entry.pending = Buffer.alloc(0);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      for (const event of entry.session.apply(record, entry.historical)) this.onEvent(event);
    }
    if (entry.offset >= size && !entry.pending.length) entry.historical = false;
  }

  snapshot() {
    const sessions = [...this.files.values()].map((e) => e.session.view())
      .filter((s) => !s.subagent && (s.active || s.state !== 'idle'))
      .sort((a, b) => b.updated - a.updated);
    return { status: this.status, home: this.home(), sessions, active: sessions.filter((s) => s.active).length };
  }
}

module.exports = { DshWatcher, DshSession, decodeFrames, recentSessions, dshHome, toolLabel };
