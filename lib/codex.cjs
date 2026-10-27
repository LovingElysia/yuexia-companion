'use strict';
// Codex 联动：只读本机 Codex 会话日志（~/.codex/sessions/**/rollout-*.jsonl），思路参考白龙桌宠的
// enhanced_core.ActivityReducer。只取生命周期与工具名，不读取、不展示推理内容和工具输出；
// 会话标题取用户消息的前 30 个字，仅在本机显示。子代理会话不提醒，避免冒充主会话。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAIL_BYTES = 256 * 1024;
const MAX_FILES = 8;
const RECENT_MS = 12 * 3600 * 1000;

function codexHome(configured) {
  return configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function cleanTitle(text, limit = 30) {
  if (typeof text !== 'string') return '';
  const value = text
    .replace(/<(environment_context|user_instructions|in-app-browser-context|[a-z_-]+_context)[\s\S]*?(<\/[^>]+>|\/>)/gi, '')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b/g, '[已隐藏]')
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
}

function isSubagent(meta) {
  let source = meta.source;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch {}
  }
  const agent = typeof meta.agent_path === 'string' ? meta.agent_path.trim() : '';
  return (source && typeof source === 'object' && 'subagent' in source) || source === 'subagent' || (!!agent && agent !== '/root');
}

function toolLabel(name) {
  const tool = String(name || '').toLowerCase();
  if (/apply_patch|edit|write/.test(tool)) return '正在编辑文件';
  if (/shell|exec|command|powershell|bash|run/.test(tool)) return '正在运行命令';
  if (/read|view|open|list|grep|find/.test(tool)) return '正在读取文件';
  if (/web|search|browse|fetch/.test(tool)) return '正在查找资料';
  return '正在使用工具';
}

/** 单个会话的状态归约；apply 返回需要让月下反应的事件（historical 为 true 时只更新状态）。 */
class SessionReducer {
  constructor(id) {
    this.id = id;
    this.title = 'Codex 对话';
    this.state = 'idle'; // idle | thinking | working | responding | waiting | complete | interrupted
    this.label = '等待新的任务';
    this.done = true;
    this.subagent = false;
    this.metaSeen = false;
    this.updated = 0;
  }

  apply(obj, historical) {
    const kind = obj && obj.type;
    const p = obj && obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
    if (!p) return [];
    const typ = p.type;
    const events = [];
    const emit = (event) => { if (!historical && !this.subagent) events.push({ ...event, session: this.id, title: this.title }); };
    const stamp = Date.parse(obj.timestamp) || Date.now();
    if (kind === 'session_meta') {
      if (!this.metaSeen) { this.subagent = isSubagent(p); this.metaSeen = true; }
      return [];
    }
    if (kind === 'event_msg' && (typ === 'task_started' || typ === 'turn_started')) {
      this.done = false; this.state = 'thinking'; this.label = '收到任务，正在思考'; this.updated = stamp;
      emit({ kind: 'start' });
    } else if (kind === 'event_msg' && typ === 'user_message') {
      this.title = cleanTitle(p.message) || this.title; this.updated = stamp;
    } else if (kind === 'response_item' && typ === 'message' && p.role === 'user' && !this.done) {
      const title = cleanTitle(contentText(p.content));
      if (title) this.title = title;
    } else if (kind === 'response_item' && (typ === 'function_call' || typ === 'custom_tool_call') && !this.done) {
      const label = toolLabel(p.name);
      this.state = 'working'; this.updated = stamp;
      if (label !== this.label) { this.label = label; emit({ kind: 'activity', label }); }
    } else if (kind === 'response_item' && typ === 'reasoning' && !this.done) {
      if (this.state !== 'thinking') { this.state = 'thinking'; this.label = '正在思考下一步'; }
      this.updated = stamp;
    } else if (kind === 'response_item' && typ === 'message' && p.role === 'assistant' && !this.done) {
      if (p.phase === 'final' || p.phase === 'final_answer') { this.state = 'responding'; this.label = '正在整理回复'; }
      this.updated = stamp;
    } else if (kind === 'event_msg' && /approval_request$/.test(String(typ)) && !this.done) {
      this.state = 'waiting'; this.label = '等待你的批准'; this.updated = stamp;
      emit({ kind: 'waiting' });
    } else if (kind === 'event_msg' && (typ === 'task_complete' || typ === 'task_completed')) {
      if (!this.done) { this.done = true; this.state = 'complete'; this.label = '任务已完成'; this.updated = stamp; emit({ kind: 'complete' }); }
    } else if (kind === 'event_msg' && (typ === 'turn_aborted' || typ === 'task_aborted' || typ === 'turn_cancelled')) {
      if (!this.done) { this.done = true; this.state = 'interrupted'; this.label = '任务已中断'; this.updated = stamp; emit({ kind: 'abort' }); }
    }
    return events;
  }

  view() {
    return { id: this.id, title: this.title, state: this.state, label: this.label, active: !this.done, updated: this.updated, subagent: this.subagent };
  }
}

/** 列出最近 3 个日期目录里 12 小时内写过的会话日志，按修改时间倒序。 */
function recentRollouts(home, now = Date.now()) {
  const root = path.join(home, 'sessions');
  const dirs = [];
  const children = (dir) => {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse(); } catch { return []; }
  };
  for (const year of children(root)) {
    for (const month of children(path.join(root, year))) {
      for (const day of children(path.join(root, year, month))) {
        dirs.push(path.join(root, year, month, day));
        if (dirs.length >= 3) break;
      }
      if (dirs.length >= 3) break;
    }
    if (dirs.length >= 3) break;
  }
  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs <= RECENT_MS) files.push({ file, mtime: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
}

function sessionIdOf(file) {
  const match = path.basename(file, '.jsonl').match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:_[0-9a-f-]+)?$/i);
  return match ? match[1].toLowerCase() : path.basename(file, '.jsonl');
}

class CodexWatcher {
  constructor({ getSettings, onEvent, log = () => {} }) {
    this.getSettings = getSettings;
    this.onEvent = onEvent;
    this.log = log;
    this.files = new Map(); // file -> { offset, buffer, reducer }
    this.timer = null;
    this.lastScan = 0;
    this.status = 'off';
  }

  home() {
    return codexHome(this.getSettings().codex.home);
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
    const home = this.home();
    const now = Date.now();
    if (now - this.lastScan > 10000) {
      this.lastScan = now;
      if (!fs.existsSync(path.join(home, 'sessions'))) { this.status = 'missing'; return; }
      const recent = recentRollouts(home, now);
      const keep = new Set(recent.map((r) => r.file));
      for (const file of this.files.keys()) if (!keep.has(file) && this.files.get(file).reducer.done) this.files.delete(file);
      for (const { file, size } of recent) {
        if (this.files.has(file)) continue;
        // 桌宠启动之后才创建的日志：整份都是新事件。更早的日志：读末尾一段建立当前状态，不补发旧提醒。
        let born = 0;
        try { born = fs.statSync(file).birthtimeMs; } catch {}
        const fresh = born > this.startedAt + 1000; // 文件时间有毫秒以下误差，留 1 秒余量
        const entry = fresh
          ? { offset: 0, buffer: '', reducer: new SessionReducer(sessionIdOf(file)), historical: false, skipFirst: false }
          : { offset: Math.max(0, size - TAIL_BYTES), buffer: '', reducer: new SessionReducer(sessionIdOf(file)), historical: true, skipFirst: size > TAIL_BYTES };
        this.files.set(file, entry);
        if (entry.offset > 0) this.readHeader(file, entry);
      }
      this.status = 'watching';
    }
    for (const [file, entry] of this.files) this.read(file, entry);
  }

  /** 只读末尾时，从日志开头补上会话来源与标题（第一条用户消息），不改变其余状态。 */
  readHeader(file, entry) {
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, entry.offset));
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf8', 0, n).split('\n');
      lines.pop();
      let titled = false;
      for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === 'session_meta') entry.reducer.apply(obj, true);
        else if (!titled && obj.type === 'event_msg' && obj.payload?.type === 'user_message') { entry.reducer.apply(obj, true); titled = true; }
        if (titled && entry.reducer.metaSeen) break;
      }
    } catch {}
  }

  read(file, entry) {
    let size;
    try { size = fs.statSync(file).size; } catch { this.files.delete(file); return; }
    if (size < entry.offset) { entry.offset = 0; entry.buffer = ''; }
    if (size === entry.offset) { entry.historical = false; return; }
    let chunk = '';
    try {
      const fd = fs.openSync(file, 'r');
      const length = Math.min(size - entry.offset, 4 * 1024 * 1024);
      const buf = Buffer.alloc(length);
      const n = fs.readSync(fd, buf, 0, length, entry.offset);
      fs.closeSync(fd);
      entry.offset += n;
      chunk = buf.toString('utf8', 0, n);
    } catch {
      return;
    }
    const lines = (entry.buffer + chunk).split('\n');
    entry.buffer = lines.pop();
    if (entry.buffer.length > 4 * 1024 * 1024) entry.buffer = '';
    if (entry.skipFirst && lines.length) { lines.shift(); entry.skipFirst = false; }
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      for (const event of entry.reducer.apply(obj, entry.historical)) this.onEvent(event);
    }
    if (entry.offset >= size) entry.historical = false;
  }

  snapshot() {
    const sessions = [...this.files.values()].map((e) => e.reducer.view())
      .filter((s) => !s.subagent && (s.active || s.state !== 'idle'))
      .sort((a, b) => b.updated - a.updated);
    return { status: this.status, home: this.home(), sessions, active: sessions.filter((s) => s.active).length };
  }
}

module.exports = { CodexWatcher, SessionReducer, recentRollouts, cleanTitle, toolLabel, sessionIdOf, codexHome };
