'use strict';
// 让月下替你给 Codex 派活：启动本机 Codex 自带的 `codex app-server`（JSON-RPC，一行一条消息），
// 在指定的任务目录里新建或续接一个对话（thread），把你的话作为一轮任务（turn）发出去，
// 并把进度、回复、批准请求转成月下的事件。额度用 account/rateLimits/read 读取（与白龙桌宠相同）。
// 用的是你本机登录的 Codex 账号额度，不需要 API 密钥。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

/** 找 Codex 命令行：设置/环境变量 → Codex 桌面版自带的 bin → PATH → npm 全局安装。 */
function findCodex(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.env.YUEXIA_CODEX) candidates.push(process.env.YUEXIA_CODEX);
  const bin = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  try {
    const found = fs.readdirSync(bin).map((d) => path.join(bin, d, 'codex.exe')).filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    candidates.push(...found, path.join(bin, 'codex.exe'));
  } catch {}
  try {
    candidates.push(...execFileSync('where', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(Boolean));
  } catch {}
  const npm = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'vendor');
  try {
    for (const arch of fs.readdirSync(npm)) candidates.push(path.join(npm, arch, 'codex', 'codex.exe'));
  } catch {}
  return candidates.find((f) => f && fs.existsSync(f)) || null;
}

function toolLabel(item) {
  switch (item && item.type) {
    case 'commandExecution': return '正在运行命令';
    case 'fileChange': return '正在修改文件';
    case 'webSearch': return '正在查找资料';
    case 'mcpToolCall': return '正在调用工具 ' + (item.tool || '');
    case 'reasoning': return '正在思考';
    case 'plan': return '正在制定计划';
    default: return null;
  }
}

const DETAIL_LIMIT = 20000;
const clip = (text) => {
  const value = String(text ?? '');
  return value.length > DETAIL_LIMIT ? value.slice(0, DETAIL_LIMIT) + `\n…（其余 ${value.length - DETAIL_LIMIT} 字省略）` : value;
};
const json = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Codex 完成的一项（ThreadItem）→ 卡片里的一步：标题 + 原样的内容（命令输出、diff、参数与结果）。 */
function stepOf(item) {
  switch (item.type) {
    case 'reasoning': {
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n\n');
      return text ? { type: 'thinking', title: '思考', detail: clip(text) } : null;
    }
    case 'plan':
      return { type: 'plan', title: '计划', detail: clip(item.text) };
    case 'commandExecution':
      return {
        type: 'command', title: item.command || '运行命令', detail: clip(item.aggregatedOutput || ''), cwd: item.cwd || '',
        exitCode: item.exitCode ?? null, status: item.status === 'failed' || (item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0) ? 'error' : 'ok',
      };
    case 'fileChange': {
      const changes = item.changes || [];
      return {
        type: 'file', title: '修改了 ' + changes.length + ' 个文件：' + changes.map((c) => c.path.split(/[\\/]/).pop()).join('、'),
        detail: clip(changes.map((c) => `--- ${c.path}（${typeof c.kind === 'string' ? c.kind : json(c.kind)}）\n${c.diff || ''}`).join('\n\n')),
        status: item.status === 'failed' ? 'error' : 'ok',
      };
    }
    case 'webSearch':
      return { type: 'search', title: '搜索：' + (item.query || item.action?.query || ''), detail: clip(json(item.action || item)) };
    case 'mcpToolCall':
      return {
        type: 'tool', title: `${item.server}.${item.tool}`, status: item.error ? 'error' : 'ok',
        detail: clip(`参数：\n${json(item.arguments)}\n\n${item.error ? '错误：\n' + json(item.error) : '结果：\n' + json(item.result)}`),
      };
    case 'dynamicToolCall':
      return { type: 'tool', title: item.tool, status: item.success === false ? 'error' : 'ok', detail: clip(`参数：\n${json(item.arguments)}\n\n结果：\n${json(item.contentItems)}`) };
    case 'imageView':
      return { type: 'tool', title: '查看图片 ' + item.path, detail: '' };
    case 'contextCompaction':
      return { type: 'note', title: '压缩了上下文', detail: '' };
    default:
      return { type: 'tool', title: item.type, detail: clip(json(item)) };
  }
}

/** 额度窗口 → [{ name, remaining, resetsAt }]（与白龙一致：5小时 / 一周）。 */
function quotaWindows(snapshot) {
  if (!snapshot) return [];
  const out = [];
  for (const key of ['primary', 'secondary']) {
    const w = snapshot[key];
    if (!w || typeof w.usedPercent !== 'number') continue;
    const mins = w.windowDurationMins;
    out.push({ name: mins === 300 ? '5小时' : mins === 10080 ? '一周' : (mins ? mins + '分钟' : key), remaining: Math.max(0, Math.round(100 - w.usedPercent)), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null });
  }
  return out;
}

class CodexAgent {
  constructor({ getSettings, onEvent, log = () => {} }) {
    this.getSettings = getSettings;
    this.onEvent = onEvent;
    this.log = log;
    this.proc = null;
    this.ready = null;
    this.nextId = 1;
    this.calls = new Map();
    this.buffer = '';
    this.thread = null; // { id, cwd }
    this.turn = null; // 正在进行的 turn id
    this.approvals = new Map(); // 批准请求 id -> { rpcId, kind, ... }
    this.quota = null;
    this.status = 'idle'; // idle | starting | ready | working | error
    this.detail = '';
    this.exe = null;
  }

  snapshot() {
    return {
      status: this.status, detail: this.detail, exe: this.exe, threadId: this.thread?.id || null, cwd: this.thread?.cwd || null,
      working: !!this.turn, approvals: [...this.approvals.values()].map(({ rpcId, ...a }) => a), quota: this.quota,
    };
  }

  emit(event) {
    this.onEvent({ target: 'codex', ...event });
  }

  start() {
    if (this.ready) return this.ready;
    this.exe = findCodex(this.getSettings().codex.exe);
    if (!this.exe) {
      this.status = 'error';
      this.detail = '没有找到 Codex 命令行：请安装并登录 Codex 桌面版';
      return Promise.reject(new Error(this.detail));
    }
    this.status = 'starting';
    const proc = spawn(this.exe, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.receive(chunk));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.log('codex', 'app-server exited ' + code);
      this.proc = null;
      this.ready = null;
      for (const { reject } of this.calls.values()) reject(new Error('Codex 连接已断开'));
      this.calls.clear();
      this.approvals.clear();
      if (this.turn) this.emit({ kind: 'done', status: 'failed', error: 'Codex 连接意外断开' });
      this.turn = null;
      this.status = 'idle';
    });
    proc.on('error', (error) => { this.status = 'error'; this.detail = error.message; });
    this.ready = (async () => {
      await this.call('initialize', { clientInfo: { name: 'yuexia_companion', title: '月下陪伴版', version: '1.0.0' } }, 30000);
      this.notify('initialized');
      this.status = 'ready';
      this.detail = '';
    })().catch((error) => {
      this.status = 'error';
      this.detail = 'Codex 启动失败：' + error.message;
      this.stop();
      throw error;
    });
    return this.ready;
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (proc) try { proc.kill(); } catch {}
  }

  send(message) {
    this.proc?.stdin.write(JSON.stringify(message) + '\n');
  }

  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  call(method, params, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(method + ' 超时')); }, timeout);
      this.calls.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method) {
        const call = this.calls.get(message.id);
        if (!call) continue;
        this.calls.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message || 'Codex 返回错误'));
        else call.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        this.serverRequest(message);
      } else if (message.method) {
        this.notification(message.method, message.params || {});
      }
    }
  }

  /** Codex 请求用户决定的事：命令与文件修改转给月下卡片；其余暂不支持的请求直接拒绝。 */
  serverRequest({ id, method, params }) {
    const p = params || {};
    if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
      const key = 'codex-' + id;
      const command = Array.isArray(p.command) ? p.command.join(' ') : p.command || '';
      this.approvals.set(key, { rpcId: id, id: key, kind: 'command', command: String(command).slice(0, 400), cwd: p.cwd || '', reason: p.reason || '' });
      this.emit({ kind: 'approval', approval: { id: key, kind: 'command', command: String(command).slice(0, 400), cwd: p.cwd || '', reason: p.reason || '' } });
    } else if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
      const key = 'codex-' + id;
      this.approvals.set(key, { rpcId: id, id: key, kind: 'file', reason: p.reason || '', cwd: p.grantRoot || '' });
      this.emit({ kind: 'approval', approval: { id: key, kind: 'file', reason: p.reason || '', cwd: p.grantRoot || '' } });
    } else {
      this.log('codex', 'declined unsupported request ' + method);
      this.send({ id, error: { code: -32601, message: '月下陪伴版暂不支持这个请求' } });
    }
  }

  answer(key, accept) {
    const approval = this.approvals.get(key);
    if (!approval) return false;
    this.approvals.delete(key);
    this.send({ id: approval.rpcId, result: { decision: accept ? 'accept' : 'decline' } });
    this.emit({ kind: 'approval-resolved', id: key, accept });
    return true;
  }

  notification(method, p) {
    if (this.thread && p.threadId && p.threadId !== this.thread.id) return;
    if (method === 'account/rateLimits/updated' && p.rateLimits?.limitId === 'codex') {
      this.quota = { windows: quotaWindows(p.rateLimits), reached: p.rateLimits.rateLimitReachedType || null, at: Date.now() };
      this.emit({ kind: 'quota', quota: this.quota });
    } else if (method === 'item/started') {
      const label = toolLabel(p.item);
      if (label) this.emit({ kind: 'progress', label });
    } else if (method === 'item/agentMessage/delta') {
      this.emit({ kind: 'delta', itemId: p.itemId, text: p.delta });
    } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
      const final = p.item.phase === 'final_answer' || p.item.phase === 'final';
      // 中途的说明原样记成一步；最终回答作为结果消息，不重复记步骤
      if (!final && p.item.text) this.emitStep({ type: 'text', title: '说明', detail: p.item.text });
      this.emit({ kind: 'message', itemId: p.item.id, text: p.item.text || '', final });
    } else if (method === 'item/completed' && p.item && p.item.type !== 'userMessage') {
      const step = stepOf(p.item);
      if (step) this.emitStep(step);
      if (p.item.type === 'fileChange') this.emit({ kind: 'progress', label: '改好了 ' + (p.item.changes || []).length + ' 个文件' });
    } else if (method === 'error' && !p.willRetry) {
      this.lastError = p.error?.codexErrorInfo === 'usageLimitExceeded' ? 'Codex 额度已用完' : (p.error?.message || 'Codex 出错了');
    } else if (method === 'turn/completed') {
      const status = p.turn?.status || 'completed';
      this.turn = null;
      this.status = 'ready';
      for (const [key, a] of this.approvals) { this.send({ id: a.rpcId, result: { decision: 'cancel' } }); this.approvals.delete(key); }
      this.emit({ kind: 'done', status, error: status === 'completed' ? null : (this.lastError || p.turn?.error?.message || '任务没有完成'), usageLimit: p.turn?.error?.codexErrorInfo === 'usageLimitExceeded' });
      this.lastError = null;
      void this.readQuota().catch(() => {});
    }
  }

  emitStep(step) {
    this.stepNo = (this.stepNo || 0) + 1;
    this.emit({ kind: 'step', step: { n: this.stepNo, ...step } });
  }

  async readQuota() {
    await this.start();
    const result = await this.call('account/rateLimits/read', undefined, 30000);
    const snapshot = result.rateLimitsByLimitId?.codex || result.rateLimits;
    this.quota = { windows: quotaWindows(snapshot), reached: snapshot?.rateLimitReachedType || null, plan: snapshot?.planType || null, at: Date.now() };
    this.emit({ kind: 'quota', quota: this.quota });
    return this.quota;
  }

  /** 发出一轮任务。threadId 为空时新建对话；否则续接那个对话（不在本进程里时用 thread/resume 从磁盘读回）。 */
  async dispatch(text, cwd, threadId = null) {
    if (this.turn) throw new Error('Codex 还在处理上一件事');
    await this.start();
    const settings = this.getSettings().codex;
    if (threadId && this.thread?.id !== threadId) {
      await this.call('thread/resume', { threadId, cwd, approvalPolicy: 'on-request', sandbox: settings.sandbox });
      this.thread = { id: threadId, cwd };
    } else if (!threadId) {
      const started = await this.call('thread/start', {
        cwd, approvalPolicy: 'on-request', sandbox: settings.sandbox,
        developerInstructions: '这个任务是用户通过桌宠「月下」转交给你的。完成后用简洁的中文总结你做了什么。',
      });
      this.thread = { id: started.thread.id, cwd };
      this.emit({ kind: 'thread', threadId: started.thread.id, model: started.model });
      void this.call('thread/name/set', { threadId: started.thread.id, name: '月下：' + text.slice(0, 20) }).catch(() => {});
    }
    this.lastError = null;
    const turn = await this.call('turn/start', { threadId: this.thread.id, input: [{ type: 'text', text, text_elements: [] }] });
    this.turn = turn.turn.id;
    this.stepNo = 0;
    this.status = 'working';
    this.emit({ kind: 'started', threadId: this.thread.id, turnId: this.turn });
    return { threadId: this.thread.id, turnId: this.turn };
  }

  async interrupt() {
    if (!this.turn || !this.thread) return false;
    await this.call('turn/interrupt', { threadId: this.thread.id, turnId: this.turn }).catch(() => {});
    return true;
  }

  reset() {
    this.thread = null;
  }
}

module.exports = { CodexAgent, findCodex, quotaWindows, toolLabel, stepOf };
