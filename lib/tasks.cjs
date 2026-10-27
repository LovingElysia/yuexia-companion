'use strict';
// 派活调度：月下卡片里选了「Codex」或「DSH」时，你的话作为任务交给对应的工具，而不是去问对话模型。
// 你的话、工具的最终回答写进当前的 Codex / DSH 会话（见 conversations.cjs），会话记住 threadId / sessionId 以便续接；
// 开始、完成、失败、需要批准时月下各说一句（固定台词，走语音缓存）。
// 月下自己派出去的会话记在 own 里，日志联动看到它们时不再重复提醒。
const fs = require('node:fs');
const { CodexAgent } = require('./codex-agent.cjs');
const { DshAgent } = require('./dsh-agent.cjs');

const NAME = { codex: 'Codex', dsh: 'DeepSeek Harness' };
const LINES = {
  dispatch: ['好，我交给{name}了，我帮你盯着。', 'curious'],
  done: ['{name}做完了哦，结果在聊天框里。', 'happy'],
  failed: ['{name}没能完成……原因我写在聊天框里了。', 'sad'],
  interrupted: ['好，我让{name}先停下了。', 'neutral'],
  approval: ['{name}想做一个操作，需要你点一下同意哦。', 'curious'],
  quota: ['{name}的额度用完了，要等一会儿才能恢复。', 'sad'],
};

function line(kind, target) {
  const [text, emotion] = LINES[kind];
  return { text: text.replace('{name}', NAME[target]), emotion };
}

class Tasks {
  constructor({ getSettings, conversations, speech, broadcast, onQuota = () => {}, log = () => {} }) {
    this.conversations = conversations;
    this.running = { codex: null, dsh: null }; // 正在执行的任务属于哪个会话
    this.runInfo = { codex: null, dsh: null }; // 本轮的步数与开始时间
    this.onQuota = onQuota;
    this.getSettings = getSettings;
    this.speech = speech;
    this.broadcast = broadcast;
    this.log = log;
    this.own = new Set();
    this.live = { codex: this.blank(), dsh: this.blank() };
    this.agents = {
      codex: new CodexAgent({ getSettings, onEvent: (e) => this.onAgent(e), log }),
      dsh: new DshAgent({ getSettings, onEvent: (e) => this.onAgent(e), log }),
    };
  }

  blank() {
    return { working: false, progress: '', text: '', lastMessage: '', approvals: [] };
  }

  snapshot() {
    const out = {};
    for (const target of ['codex', 'dsh']) {
      const s = this.getSettings()[target];
      const conv = this.conversations.active(target);
      out[target] = { ...this.agents[target].snapshot(), workdir: conv.cwd || s.workdir, conversation: conv.id, running: this.running[target], live: this.live[target] };
    }
    return out;
  }

  async dispatch(target, text) {
    const agent = this.agents[target];
    if (!agent) throw new Error('未知的派活对象');
    const message = String(text || '').trim().slice(0, 8000);
    if (!message) throw new Error('说说要做什么吧');
    const conv = this.conversations.active(target);
    // 已经开始过的会话固定在它原来的目录里继续；新会话用卡片上选的任务目录
    const cwd = (conv.threadId || conv.sessionId) && conv.cwd ? conv.cwd : this.getSettings()[target].workdir;
    if (!cwd) throw new Error('先在卡片上方选一个任务目录');
    if (!fs.existsSync(cwd)) throw new Error('任务目录不存在：' + cwd);
    this.live[target] = { ...this.blank(), working: true, progress: '正在交给' + NAME[target] };
    this.running[target] = conv.id;
    this.runInfo[target] = { steps: 0, started: Date.now() };
    this.conversations.update(conv.id, { cwd });
    const user = this.conversations.append(conv.id, { role: 'user', channel: target, text: message, cwd });
    this.broadcast('task', { target, kind: 'queued', conversation: conv.id, message: user, live: this.live[target] });
    try {
      await agent.dispatch(message, cwd, target === 'codex' ? conv.threadId || null : conv.sessionId || null);
    } catch (error) {
      this.live[target] = this.blank();
      this.running[target] = null;
      const reply = this.conversations.append(conv.id, { role: 'assistant', channel: target, text: error.message, status: 'failed' });
      this.broadcast('task', { target, kind: 'done', status: 'failed', conversation: conv.id, message: reply, live: this.live[target] });
      throw error;
    }
    this.speech.say({ ...line('dispatch', target), source: 'work' });
    return user;
  }

  onAgent(event) {
    const { target } = event;
    const live = this.live[target];
    if (event.kind === 'started' || event.kind === 'thread') {
      const id = event.threadId || event.sessionId;
      if (id) this.own.add(id);
      if (id && this.running[target]) this.conversations.update(this.running[target], target === 'codex' ? { threadId: id } : { sessionId: id });
    } else if (event.kind === 'step') {
      // Codex / DSH 的每一步原样记进会话：说明、思考、命令与输出、改动的文件、工具参数与结果
      const convId = this.running[target];
      if (!convId || !this.conversations.get(convId)) return;
      if (this.runInfo[target]) this.runInfo[target].steps++;
      const message = this.conversations.append(convId, { role: 'step', channel: target, ...event.step });
      this.broadcast('task', { target, kind: 'step', conversation: convId, message, live });
      return;
    } else if (event.kind === 'progress') {
      live.progress = event.label;
    } else if (event.kind === 'delta') {
      live.text += event.text;
    } else if (event.kind === 'message') {
      live.lastMessage = event.text;
      live.text = '';
      if (!event.final) live.progress = event.text.split(/\n/)[0].slice(0, 60);
    } else if (event.kind === 'approval') {
      live.approvals = [...live.approvals, event.approval];
      this.speech.say({ ...line('approval', target), caption: event.approval.command || event.approval.reason || '', source: 'work' });
    } else if (event.kind === 'approval-resolved') {
      live.approvals = live.approvals.filter((a) => a.id !== event.id);
    } else if (event.kind === 'done') {
      const status = event.status === 'completed' ? 'completed' : event.status === 'interrupted' ? 'interrupted' : 'failed';
      const text = status === 'completed' ? (live.lastMessage || '（完成了，没有留下文字说明）') : [live.lastMessage, event.error].filter(Boolean).join('\n\n') || '任务中断了';
      const convId = this.running[target];
      const info = this.runInfo[target] || { steps: 0, started: Date.now() };
      this.running[target] = null;
      this.runInfo[target] = null;
      // 会话在任务进行中被删掉时，结果就不再保存
      const reply = convId && this.conversations.get(convId)
        ? this.conversations.append(convId, { role: 'assistant', channel: target, text, status, steps: info.steps, durationMs: Date.now() - info.started })
        : null;
      this.live[target] = this.blank();
      this.broadcast('task', { target, kind: 'done', status, conversation: convId, message: reply, live: this.live[target] });
      const kind = event.usageLimit ? 'quota' : status === 'completed' ? 'done' : status;
      this.speech.say({ ...line(kind, target), source: 'work' });
      return;
    } else if (event.kind === 'quota') {
      this.onQuota(event.quota);
      return;
    }
    this.broadcast('task', { target, kind: event.kind, live });
  }

  answer(target, id, accept) {
    return this.agents[target]?.answer?.(id, accept) || false;
  }

  async interrupt(target) {
    return this.agents[target]?.interrupt() || false;
  }

  /** 当前会话正在执行任务时不能删除。 */
  busy(convId) {
    return this.running.codex === convId || this.running.dsh === convId;
  }

  stop() {
    this.agents.codex.stop();
    this.agents.dsh.interrupt();
  }

  /** 卡片要显示的派活台词，供语音预合成。 */
  static fixedLines() {
    return Object.keys(LINES).flatMap((kind) => ['codex', 'dsh'].map((t) => line(kind, t)));
  }
}

module.exports = { Tasks, NAME };
