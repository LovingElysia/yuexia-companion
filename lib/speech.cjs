'use strict';
// 说话调度：气泡文字立即广播，语音合成好后再广播音频地址，由气泡窗口在月下待机时播放。
// 工作提醒做限流和去重，避免长任务里反复唠叨。
const crypto = require('node:crypto');
const persona = require('./persona.cjs');

class Speech {
  constructor({ voice, getSettings, broadcast, log = () => {} }) {
    this.voice = voice;
    this.getSettings = getSettings;
    this.broadcast = broadcast;
    this.log = log;
    this.petPhase = 'unknown';
    this.lastWork = new Map(); // kind:session -> time
    this.lastActivity = 0;
    this.prewarmed = false;
  }

  wantsVoice(source) {
    const v = this.getSettings().voice;
    if (!v.enabled) return false;
    if (source === 'test') return true;
    if (source === 'chat') return v.speakChat;
    return v.speakWork;
  }

  /** 让月下说一句话。voice=false 时只显示气泡。返回广播出去的 say 事件。 */
  say({ text, emotion = 'neutral', source = 'chat', voice = true, caption = '' }) {
    const line = String(text || '').trim();
    if (!line) return null;
    const event = { id: crypto.randomUUID(), text: line, caption, emotion, source, ts: Date.now(), voice: voice && this.wantsVoice(source) };
    this.broadcast('say', event);
    if (event.voice) {
      const spoken = persona.speakable(line);
      // 显卡合成时边合成边播放：先把流式地址发给气泡，气泡开始播放时才合成；已缓存的句子照旧直接播
      if (!this.voice.cached(spoken, emotion) && this.voice.streaming()) {
        const id = this.voice.openStream(spoken, emotion);
        this.broadcast('audio', { id: event.id, url: `/api/audio/stream/${id}.wav`, stream: true });
        return event;
      }
      this.voice.synthesize(spoken, emotion)
        .then((result) => this.broadcast('audio', { id: event.id, url: `/api/audio/${result.key}.wav`, ms: result.ms, cached: !!result.cached }))
        .catch((error) => {
          this.log('speech', 'synth failed: ' + error.message);
          this.broadcast('audio-error', { id: event.id, message: error.message });
        });
    }
    return event;
  }

  /** Codex / DSH 的工作事件 → 月下的反应。 */
  work(event) {
    const settings = this.getSettings();
    const now = Date.now();
    const key = event.kind + ':' + event.session;
    const gap = { start: 45000, waiting: 15000, complete: 4000, abort: 8000, error: 8000 }[event.kind];
    const work = settings.work;
    if (event.kind === 'activity') {
      // 工具调用只换气泡文字，不出声；全局 20 秒最多一次
      if (now - this.lastActivity < 20000) return null;
      this.lastActivity = now;
      return this.say({ text: event.label, caption: work.showTitle ? event.title : '', emotion: 'neutral', source: 'work', voice: false });
    }
    if (gap === undefined) return null;
    if (now - (this.lastWork.get(key) || 0) < gap) return null;
    if (event.kind === 'start' && !work.speakStart) return null;
    if (event.kind === 'complete' && !work.speakComplete) return null;
    if ((event.kind === 'abort' || event.kind === 'error') && !work.speakAbort) return null;
    this.lastWork.set(key, now);
    const line = persona.workLine(event.kind);
    if (!line) return null;
    return this.say({ ...line, caption: work.showTitle ? event.title : '', source: 'work' });
  }

  /** 语音服务就绪后，空闲时逐句预合成固定台词，之后的提醒直接走缓存。 */
  async prewarm(isBusy) {
    if (this.prewarmed || !this.getSettings().voice.enabled) return;
    this.prewarmed = true;
    const lines = [...persona.fixedLines(), ...require('./tasks.cjs').Tasks.fixedLines(), persona.greeting()];
    for (const { text, emotion } of lines) {
      if (this.voice.cached(text, emotion)) continue;
      while (this.voice.pending > 0 || isBusy()) await new Promise((resolve) => setTimeout(resolve, 3000));
      if (this.voice.state !== 'ready') { this.prewarmed = false; return; }
      try { await this.voice.synthesize(text, emotion); } catch { this.prewarmed = false; return; }
    }
    this.log('speech', 'prewarm complete');
  }
}

module.exports = { Speech };
