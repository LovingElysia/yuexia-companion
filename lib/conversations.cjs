'use strict';
// 会话管理：闲聊、Codex 派活、DSH 派活各有自己的会话列表，可以新建、切换、改名、删除。
// 索引在 conversations.json，每个会话的消息单独存一个文件（conversations/<id>.json）。
// Codex 会话记住 threadId，DSH 会话记住 sessionId，切回旧会话时接着原来的上下文继续。
// 删除只删除月下这里的记录，不会删除 Codex / DSH 自己保存的对话。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileSafe } = require('./settings.cjs');

const TARGETS = ['chat', 'codex', 'dsh'];
const MESSAGE_LIMIT = 2000; // 派活会原样记下每一步，条数会比较多
const DEFAULT_TITLE = { chat: '新的闲聊', codex: '新的 Codex 任务', dsh: '新的 DSH 任务' };

class Conversations {
  constructor({ dataDir }) {
    this.dir = path.join(dataDir, 'conversations');
    this.indexFile = path.join(dataDir, 'conversations.json');
    this.legacyFile = path.join(dataDir, 'chat-history.json');
    this.cache = new Map(); // id -> messages
    this.index = this.load();
  }

  load() {
    try {
      const index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (Array.isArray(index.list)) return { list: index.list, active: index.active || {} };
    } catch {}
    return this.migrate();
  }

  /** 旧版只有一条 chat-history.json：按 channel 拆成三条会话。 */
  migrate() {
    const index = { list: [], active: {} };
    let legacy = [];
    try { legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')); } catch {}
    if (!Array.isArray(legacy)) legacy = [];
    for (const target of TARGETS) {
      const messages = legacy.filter((m) => (m.channel || 'chat') === target);
      if (!messages.length) continue;
      const conv = this.blank(target, messages.find((m) => m.role === 'user')?.text);
      conv.created = messages[0].ts || Date.now();
      conv.updated = messages[messages.length - 1].ts || Date.now();
      conv.count = messages.length;
      index.list.push(conv);
      index.active[target] = conv.id;
      this.cache.set(conv.id, messages);
      this.writeMessages(conv.id, messages);
    }
    this.index = index;
    this.saveIndex();
    return index;
  }

  blank(target, firstText) {
    const now = Date.now();
    return { id: crypto.randomUUID(), target, title: firstText ? titleOf(firstText) : DEFAULT_TITLE[target], auto: !firstText, created: now, updated: now, count: 0 };
  }

  saveIndex() {
    writeFileSafe(this.indexFile, JSON.stringify(this.index, null, 1));
  }

  writeMessages(id, messages) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileSafe(path.join(this.dir, id + '.json'), JSON.stringify(messages.slice(-MESSAGE_LIMIT), null, 1));
  }

  get(id) {
    return this.index.list.find((c) => c.id === id) || null;
  }

  list(target) {
    return this.index.list.filter((c) => !target || c.target === target).sort((a, b) => b.updated - a.updated);
  }

  /** 当前会话；没有时自动新建一条。 */
  active(target) {
    const conv = this.get(this.index.active[target]);
    return conv && conv.target === target ? conv : this.create(target);
  }

  create(target) {
    if (!TARGETS.includes(target)) throw new Error('未知的会话类型');
    // 当前会话还是空的就直接复用，避免点几次“新建”留下一串空会话
    const current = this.get(this.index.active[target]);
    if (current && current.count === 0) return current;
    const conv = this.blank(target);
    this.index.list.push(conv);
    this.index.active[target] = conv.id;
    this.cache.set(conv.id, []);
    this.saveIndex();
    return conv;
  }

  activate(id) {
    const conv = this.get(id);
    if (!conv) throw new Error('找不到这个会话');
    this.index.active[conv.target] = conv.id;
    this.saveIndex();
    return conv;
  }

  rename(id, title) {
    const conv = this.get(id);
    if (!conv) throw new Error('找不到这个会话');
    const value = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!value) throw new Error('名字不能为空');
    conv.title = value;
    conv.auto = false;
    this.saveIndex();
    return conv;
  }

  remove(id) {
    const conv = this.get(id);
    if (!conv) return false;
    this.index.list = this.index.list.filter((c) => c.id !== id);
    if (this.index.active[conv.target] === id) {
      const next = this.list(conv.target)[0];
      if (next) this.index.active[conv.target] = next.id;
      else delete this.index.active[conv.target];
    }
    this.cache.delete(id);
    fs.rmSync(path.join(this.dir, id + '.json'), { force: true });
    this.saveIndex();
    return true;
  }

  /** 更新会话的附加信息（threadId / sessionId / cwd）。 */
  update(id, patch) {
    const conv = this.get(id);
    if (!conv) return null;
    for (const key of ['threadId', 'sessionId', 'cwd']) if (patch[key] !== undefined) conv[key] = patch[key];
    this.saveIndex();
    return conv;
  }

  messages(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(this.dir, id + '.json'), 'utf8')); } catch {}
    if (!Array.isArray(list)) list = [];
    this.cache.set(id, list);
    return list;
  }

  append(id, entry) {
    const conv = this.get(id);
    if (!conv) throw new Error('会话已被删除');
    const message = { id: crypto.randomUUID(), ts: Date.now(), ...entry };
    const list = this.messages(id);
    list.push(message);
    if (list.length > MESSAGE_LIMIT) list.splice(0, list.length - MESSAGE_LIMIT);
    conv.count = list.length;
    conv.updated = message.ts;
    // 还没改过名的会话用第一句话当标题
    if (conv.auto && entry.role === 'user') { conv.title = titleOf(entry.text); conv.auto = false; }
    this.writeMessages(id, list);
    this.saveIndex();
    return message;
  }

  clear(id) {
    const conv = this.get(id);
    if (!conv) return;
    this.cache.set(id, []);
    conv.count = 0;
    this.writeMessages(id, []);
    this.saveIndex();
  }
}

function titleOf(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > 24 ? value.slice(0, 24) + '…' : value || '新会话';
}

module.exports = { Conversations, TARGETS, titleOf };
