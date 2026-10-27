// 头顶对话气泡：显示月下说的话；语音合成好后在待机时播放，月下开始表演动作时立即收起并停声。
import { subscribe } from './api.js';

const bridge = window.companionBridge;
const bubble = document.querySelector('#bubble');
const text = document.querySelector('#text');
const caption = document.querySelector('#caption');
const voice = document.querySelector('#voice');
const tail = document.querySelector('#tail');
const audio = new Audio();

let current = null, hideTimer = null, phase = 'unknown', volume = 0.9, idleOnly = true, tailX = 150;

const idle = () => phase === 'idle' || phase === 'unknown';

// ---------------------------------------------------------------- 流式语音（显卡合成时）
// <audio> 遇到长度未知的 WAV 会先缓冲到快结束才开始播，所以流式语音用 Web Audio：边收 16 位 PCM 边排进播放队列。
let context = null, stream = null;
const speaking = () => !audio.paused || !!stream;

function stopStream() {
  const job = stream;
  stream = null;
  if (!job) return;
  job.abort.abort();
  for (const source of job.sources) { try { source.stop(); } catch {} }
}

async function playStream(url, onStart, onEnd) {
  stopStream();
  context ||= new AudioContext();
  if (context.state === 'suspended') await context.resume().catch(() => {});
  const job = { abort: new AbortController(), sources: [] };
  stream = job;
  const gain = context.createGain();
  gain.gain.value = volume;
  gain.connect(context.destination);
  const response = await fetch(url, { signal: job.abort.signal });
  if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
  const reader = response.body.getReader();
  let head = new Uint8Array(0), rate = 0, channels = 1, carry = null, at = 0, last = null;
  const schedule = (bytes) => {
    if (carry) { const joined = new Uint8Array(carry.length + bytes.length); joined.set(carry); joined.set(bytes, carry.length); bytes = joined; carry = null; }
    const usable = bytes.length - (bytes.length % (2 * channels));
    if (usable < bytes.length) carry = bytes.slice(usable);
    if (!usable) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
    const frames = usable / 2 / channels;
    const buffer = context.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const out = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = view.getInt16((i * channels + c) * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    // 网络慢于播放时接着当前时间继续，中间只是停顿一下
    at = Math.max(at, context.currentTime + 0.08);
    source.start(at);
    if (!job.sources.length) onStart();
    at += buffer.duration;
    job.sources.push(source);
    last = source;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done || stream !== job) break;
    if (!rate) {
      const joined = new Uint8Array(head.length + value.length);
      joined.set(head); joined.set(value, head.length);
      head = joined;
      const text = new TextDecoder('ascii').decode(head);
      const data = text.indexOf('data', 12);
      if (data < 0 || head.length < data + 8) continue;
      const info = new DataView(head.buffer, head.byteOffset, head.length);
      channels = info.getUint16(22, true) || 1;
      rate = info.getUint32(24, true);
      schedule(head.slice(data + 8));
      continue;
    }
    schedule(value);
  }
  if (stream !== job) return;
  const finish = () => { if (stream === job) { stream = null; onEnd(); } };
  if (last) last.onended = finish;
  else finish();
}

function setVisible(on) {
  bubble.classList.toggle('on', on);
  bridge?.bubbleVisible(on);
  if (!on) bridge?.bubblePass(true);
}

function placeTail() {
  const left = Math.max(18, Math.min(bubble.offsetWidth - 18, tailX - bubble.offsetLeft));
  tail.style.left = left + 'px';
}

function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (speaking()) return;
    current = null;
    setVisible(false);
  }, ms);
}

function show(event) {
  if (!idle()) return; // 表演中不插话
  audio.pause();
  stopStream();
  current = event;
  text.textContent = event.text;
  caption.textContent = event.caption ? '「' + event.caption + '」' : '';
  voice.className = 'voice' + (event.voice ? ' loading' : '');
  setVisible(true);
  requestAnimationFrame(placeTail);
  // 等语音时多留一会儿；纯文字按字数停留
  scheduleHide(event.voice ? 60000 : Math.max(4500, event.text.length * 240));
}

// 最近说过的话：语音晚到（例如语音服务刚启动）时，气泡已收起也能重新弹出来说完
const recent = new Map();
function remember(event) {
  recent.set(event.id, event);
  for (const [id, e] of recent) if (Date.now() - e.ts > 180000) recent.delete(id);
}

function play(event) {
  if (idleOnly && !idle()) return;
  if (!current || event.id !== current.id) {
    const late = recent.get(event.id);
    if (!late || speaking()) return;
    show(late);
  }
  if (event.stream) {
    playStream(event.url, () => {
      voice.className = 'voice speaking';
      clearTimeout(hideTimer);
    }, () => {
      voice.className = 'voice';
      scheduleHide(2600);
    }).catch(() => {
      stream = null;
      voice.className = 'voice';
      if (current) scheduleHide(Math.max(4500, current.text.length * 240));
    });
    return;
  }
  audio.src = event.url;
  audio.volume = volume;
  audio.play().then(() => {
    voice.className = 'voice speaking';
    clearTimeout(hideTimer);
  }).catch(() => {
    voice.className = 'voice';
    scheduleHide(Math.max(4500, current.text.length * 240));
  });
}

audio.addEventListener('ended', () => {
  voice.className = 'voice';
  scheduleHide(2600);
});

bubble.addEventListener('mouseenter', () => bridge?.bubblePass(false));
bubble.addEventListener('mouseleave', () => bridge?.bubblePass(true));
bubble.addEventListener('click', () => bridge?.openCard());
bridge?.onTail((x) => { tailX = x; placeTail(); });

subscribe({
  state: (s) => {
    phase = s.pet.phase;
    volume = s.settings.voice.volume;
    idleOnly = s.settings.voice.idleOnly;
  },
  phase: ({ phase: next }) => {
    phase = next;
    if (!idle()) {
      audio.pause();
      stopStream();
      clearTimeout(hideTimer);
      current = null;
      setVisible(false);
    }
  },
  say: (event) => { remember(event); show(event); },
  audio: play,
  'audio-error': (event) => {
    if (!current || event.id !== current.id) return;
    voice.className = 'voice';
    scheduleHide(Math.max(4500, current.text.length * 240));
  },
});
