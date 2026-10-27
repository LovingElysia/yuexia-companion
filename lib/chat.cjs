'use strict';
// 和月下对话：OpenAI 兼容接口（默认 DeepSeek 官方地址），直接由陪伴版发起，不依赖其他桌宠程序。
// 对话记录按会话存在本机（见 conversations.cjs）；发给模型的只有人设、时间和当前会话最近几轮记录。
const persona = require('./persona.cjs');

/** 没填模型时：DeepSeek 官方接口默认用 deepseek-flash（快、便宜，适合桌宠的短回复）。 */
function modelOf(chat) {
  if (chat.model) return chat.model;
  try { return /(^|\.)deepseek\.com$/.test(new URL(chat.baseUrl).hostname) ? 'deepseek-flash' : ''; } catch { return ''; }
}

class ChatService {
  constructor({ getSettings, conversations }) {
    this.getSettings = getSettings;
    this.conversations = conversations;
    this.busy = false;
  }

  status() {
    const chat = this.getSettings().chat;
    if (chat.provider === 'off') return { ready: false, detail: '对话已关闭' };
    if (chat.provider === 'openai') {
      if (!chat.apiKey) return { ready: false, detail: '还没有填写 API 密钥' };
      if (!modelOf(chat)) return { ready: false, detail: '还没有填写模型名称' };
      return { ready: true, detail: `${modelOf(chat)} · ${new URL(chat.baseUrl).host}` };
    }
    return { ready: false, detail: '对话已关闭' };
  }

  /** 在当前闲聊会话里发送一句话，返回月下的回复消息（含语气）。失败抛出带中文说明的错误，不写入记录。 */
  async send(text) {
    const message = String(text || '').trim().slice(0, 2000);
    if (!message) throw new Error('说点什么吧');
    if (this.busy) throw new Error('月下还在想上一句');
    const status = this.status();
    if (!status.ready) throw new Error(status.detail);
    this.busy = true;
    try {
      const chat = this.getSettings().chat;
      const conv = this.conversations.active('chat');
      const raw = await this.viaOpenAI(message, chat, conv.id);
      const reply = persona.parseReply(raw);
      if (!reply.text) throw new Error('模型没有给出回复');
      this.conversations.append(conv.id, { role: 'user', channel: 'chat', text: message });
      return { ...this.conversations.append(conv.id, { role: 'assistant', channel: 'chat', text: reply.text, emotion: reply.emotion, provider: chat.provider }), conversation: conv.id };
    } finally {
      this.busy = false;
    }
  }

  context(rounds, convId) {
    if (!rounds) return [];
    // 只带当前闲聊会话的记录；派给 Codex / DSH 的任务在各自的会话里，不进对话模型的上下文
    return this.conversations.messages(convId).slice(-rounds * 2).map((m) => ({ role: m.role, content: m.role === 'assistant' ? `[${m.emotion || 'neutral'}]${m.text}` : m.text }));
  }

  async viaOpenAI(message, chat, convId) {
    const response = await fetch(chat.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + chat.apiKey },
      body: JSON.stringify({
        model: modelOf(chat),
        messages: [
          { role: 'system', content: persona.systemPrompt(chat.persona) },
          ...this.context(chat.memoryRounds, convId),
          { role: 'user', content: message },
        ],
        temperature: 0.85,
        max_tokens: 300,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    }).catch((error) => {
      if (error.name === 'TimeoutError') throw new Error('对话服务 60 秒没有回应，请稍后再试');
      throw new Error('连不上对话服务：' + (error.cause?.code || error.message));
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      const detail = body?.error?.message || body?.message || '';
      throw new Error(`对话服务返回 ${response.status}${detail ? '：' + String(detail).slice(0, 160) : ''}`);
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('对话服务的回复格式无法识别');
    return content;
  }

  /** DeepSeek 官方接口的账户余额（其他服务商没有统一的余额接口，返回 null）。 */
  async balance() {
    const chat = this.getSettings().chat;
    if (!chat.apiKey || !/(^|\.)deepseek\.com$/.test(new URL(chat.baseUrl).hostname)) return null;
    const response = await fetch(new URL(chat.baseUrl).origin + '/user/balance', { headers: { authorization: 'Bearer ' + chat.apiKey }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('读取余额失败（HTTP ' + response.status + '）');
    const body = await response.json();
    const info = (body.balance_infos || [])[0];
    return info ? {
      available: !!body.is_available, total: Number(info.total_balance), topped: Number(info.topped_up_balance), granted: Number(info.granted_balance),
      currency: info.currency, at: Date.now(),
    } : null;
  }

  /** OpenAI 兼容接口的模型列表（填好地址和密钥后在控制台里选）。 */
  async models() {
    const chat = this.getSettings().chat;
    if (!chat.apiKey) throw new Error('先填写 API 密钥');
    const response = await fetch(chat.baseUrl + '/models', { headers: { authorization: 'Bearer ' + chat.apiKey }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}）`);
    const body = await response.json();
    return (body?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string').sort();
  }
}

module.exports = { ChatService };
