'use strict';
// 本机 GPT-SoVITS 语音服务（D:\Development\GPT-SoVITS\voice-server.py）的客户端：
// 健康检查、按需启动、排队合成与磁盘缓存。音色只传档案名（默认 yuexia），参考音频由服务端固定映射，
// 不会把任何路径从这里传给服务。CPU 合成约为音频时长的 2 倍，所以一次只合成一句、其余排队。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeFileSafe } = require('./settings.cjs');
const gpu = require('./gpu.cjs');

const CACHE_LIMIT = 400;

class VoiceService {
  constructor({ dataDir, getSettings, log = () => {} }) {
    this.dataDir = dataDir;
    this.cacheDir = path.join(dataDir, 'voice-cache');
    this.device = null; // 最近一次的设备检测结论
    this.logFile = path.join(dataDir, 'voice-server.log');
    this.getSettings = getSettings;
    this.log = log;
    this.state = 'unknown'; // unknown | offline | starting | ready | error
    this.detail = '';
    this.voices = [];
    this.child = null;
    this.chain = Promise.resolve();
    this.pending = 0;
    this.listeners = new Set();
    this.rtf = null; // 最近一次整句合成：用时 / 音频时长，小于 1 说明快于实时
    this.streams = new Map(); // 流式播放：id -> 待合成的句子，播放器来取时才开始合成
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setState(state, detail = '') {
    if (state === this.state && detail === this.detail) return;
    this.state = state;
    this.detail = detail;
    for (const fn of this.listeners) fn(this.snapshot());
  }

  snapshot() {
    const voice = this.getSettings().voice;
    return {
      state: this.state, detail: this.detail, url: voice.url, profile: voice.profile, voices: this.voices,
      pending: this.pending, managed: !!this.child, cacheDir: this.cacheDir,
      device: this.device && { device: this.device.device, reason: this.device.reason, needsCudaTorch: !!this.device.needsCudaTorch, gpu: this.device.torch && this.device.torch.name },
    };
  }

  async health(timeoutMs = 3000) {
    const { url } = this.getSettings().voice;
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const body = await response.json();
      return body && body.status === 'ok' ? body : null;
    } catch {
      return null;
    }
  }

  async refresh() {
    const body = await this.health();
    if (body) {
      this.voices = Array.isArray(body.voices) ? body.voices : [];
      const { profile } = this.getSettings().voice;
      this.setState('ready', this.voices.includes(profile) ? '' : `服务里没有音色档案「${profile}」`);
    } else if (this.state !== 'starting') {
      this.setState('offline', '语音服务未运行');
    }
    return this.state;
  }

  isLocal() {
    try {
      const url = new URL(this.getSettings().voice.url);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    } catch {
      return false;
    }
  }

  /** 启动本机语音服务（若尚未运行）。父进程看门狗：本服务退出后语音服务随之退出。 */
  async start() {
    if (await this.health()) return this.refresh();
    if (this.child) return this.state;
    if (!this.isLocal()) {
      this.setState('offline', '远程语音地址无法由桌宠启动');
      return this.state;
    }
    const { root, url } = this.getSettings().voice;
    const python = path.join(root, '.venv', 'Scripts', 'python.exe');
    const script = path.join(root, 'voice-server.py');
    const config = path.join(root, 'voice-server.yaml');
    const missing = [python, script, config].find((file) => !fs.existsSync(file));
    if (missing) {
      this.setState('error', '找不到语音服务文件：' + missing);
      return this.state;
    }
    // 有能用的 NVIDIA 显卡就跑在 GPU 上；只有确实用不了时才退回 CPU，并说明原因
    this.setState('starting', '正在检测显卡…');
    this.device = await gpu.cachedDetect({ dataDir: this.dataDir, python, preference: this.getSettings().voice.device });
    const deviceConfig = gpu.deviceConfig(config, path.join(this.dataDir, 'voice-server.' + this.device.device + '.yaml'), this.device);
    this.log('voice', 'device ' + this.device.device + ': ' + this.device.reason);
    fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
    const out = fs.openSync(this.logFile, 'a');
    const port = new URL(url).port || '9880';
    this.setState('starting', this.device.device === 'cuda' ? '正在用显卡载入大月下音色' : '正在用 CPU 载入大月下音色，首次约 1—2 分钟');
    this.log('voice', `starting ${script} on ${port}`);
    const child = spawn(python, ['-u', script, '-a', '127.0.0.1', '-p', port, '-c', deviceConfig], {
      cwd: path.join(root, 'repo'),
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', MPLCONFIGDIR: path.join(root, '.mplconfig'), LOVER_PARENT_PID: String(process.pid) },
    });
    fs.closeSync(out);
    this.child = child;
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.log('voice', `voice server exited ${code}`);
      if (this.state === 'starting') this.setState('error', `语音服务启动失败（退出码 ${code}），详见 ${this.logFile}`);
      else this.setState('offline', '语音服务已退出');
    });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && this.child === child) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (await this.health(2000)) return this.refresh();
    }
    if (this.child === child) this.setState('error', '语音服务在 4 分钟内没有就绪，详见 ' + this.logFile);
    return this.state;
  }

  /** 只停止由本服务启动的语音进程；别人启动的服务不动。 */
  async stop() {
    const child = this.child;
    if (!child) return false;
    this.child = null;
    await new Promise((resolve) => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('exit', resolve).on('error', resolve));
    this.setState('offline', '语音服务已停止');
    return true;
  }

  cacheKey(text, emotion) {
    const { profile, speed } = this.getSettings().voice;
    return crypto.createHash('sha256').update(JSON.stringify([profile, emotion, speed, text])).digest('hex').slice(0, 32);
  }

  cachePath(key) {
    return path.join(this.cacheDir, key + '.wav');
  }

  cached(text, emotion) {
    const file = this.cachePath(this.cacheKey(text, emotion));
    return fs.existsSync(file) ? file : null;
  }

  /** 合成一句（排队、带缓存），返回 { key, file, ms }。 */
  synthesize(text, emotion = 'neutral') {
    const key = this.cacheKey(text, emotion);
    const file = this.cachePath(key);
    if (fs.existsSync(file)) return Promise.resolve({ key, file, ms: wavMs(fs.readFileSync(file)), cached: true });
    this.pending++;
    this.setState(this.state, this.detail);
    const job = this.chain.then(() => this.request(text, emotion, key, file));
    this.chain = job.catch(() => {}).finally(() => {
      this.pending--;
      for (const fn of this.listeners) fn(this.snapshot());
    });
    return job;
  }

  async request(text, emotion, key, file) {
    if (fs.existsSync(file)) return { key, file, ms: wavMs(fs.readFileSync(file)), cached: true };
    if (this.state !== 'ready' && !(await this.health())) {
      if (this.getSettings().voice.autoStart && this.isLocal()) await this.start();
      // 正在载入（首次约 1—2 分钟）时等它就绪，而不是让这句话直接失去声音
      const deadline = Date.now() + 240000;
      while (this.state === 'starting' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1000));
      if (this.state !== 'ready') throw new Error(this.detail || '语音服务未就绪');
    }
    const voice = this.getSettings().voice;
    const started = Date.now();
    const response = await fetch(voice.url + '/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        voice: voice.profile, emotion, text, text_lang: 'zh', text_split_method: 'auto',
        speed_factor: voice.speed, media_type: 'wav', streaming_mode: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      let message = `语音合成失败（HTTP ${response.status}）`;
      try { message += '：' + ((await response.json()).message || ''); } catch {}
      throw new Error(message);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.length > 40 * 1024 * 1024) throw new Error('语音服务返回的不是 WAV');
    writeFileSafe(file, bytes);
    this.prune();
    this.log('voice', `synth ${text.length} chars in ${Date.now() - started} ms`);
    const ms = wavMs(bytes);
    if (ms) this.rtf = (Date.now() - started) / ms;
    return { key, file, ms, cached: false, elapsedMs: Date.now() - started };
  }

  /** 是否边合成边播放：开关打开，并且合成快于实时——本机显卡，或别处的服务（例如 Colab GPU）实测快于实时。
   *  CPU 合成约为音频时长的 2 倍，流式只会一卡一卡的，所以仍然整句合成好再播。 */
  streaming() {
    const voice = this.getSettings().voice;
    if (!voice.stream || this.state !== 'ready') return false;
    if (this.child) return this.device?.device === 'cuda';
    // 远程 GPU 每句还有约 1.5 秒的往返开销，短句实测接近 1 倍；本机 CPU 是 2—3 倍，以 1.5 倍为界
    return this.rtf !== null && this.rtf < 1.5;
  }

  /** 登记一句流式语音，返回播放地址里的 id；播放器来取时才开始合成。 */
  openStream(text, emotion = 'neutral') {
    for (const [id, entry] of this.streams) if (Date.now() - entry.ts > 5 * 60 * 1000) this.streams.delete(id);
    const id = crypto.randomBytes(16).toString('hex');
    this.streams.set(id, { text, emotion, key: this.cacheKey(text, emotion), ts: Date.now() });
    return id;
  }

  /** 把一句流式语音写给播放器（HTTP 响应），同时存进缓存；与整句合成共用同一个队列。 */
  pipe(id, res) {
    const entry = this.streams.get(id);
    this.streams.delete(id);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":"stream-not-found"}');
      return Promise.resolve();
    }
    const file = this.cachePath(entry.key);
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
      return Promise.resolve();
    }
    this.pending++;
    this.setState(this.state, this.detail);
    const job = this.chain.then(() => this.streamRequest(entry, file, res));
    this.chain = job.catch(() => {}).finally(() => {
      this.pending--;
      for (const fn of this.listeners) fn(this.snapshot());
    });
    return job;
  }

  async streamRequest({ text, emotion }, file, res) {
    const voice = this.getSettings().voice;
    const started = Date.now();
    const fail = (message) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end();
      throw new Error(message);
    };
    let response;
    try {
      // 流式模式 2：逐段生成、逐段返回，音质与整句合成相近（模式 3 更快但音质更差）
      response = await fetch(voice.url + '/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          voice: voice.profile, emotion, text, text_lang: 'zh', text_split_method: 'auto',
          speed_factor: voice.speed, media_type: 'wav', streaming_mode: 2,
        }),
        signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      return fail('流式语音请求失败：' + error.message);
    }
    if (!response.ok || !response.body) return fail(`流式语音合成失败（HTTP ${response.status}）`);
    // 服务先发一个数据长度为 0 的 WAV 头，再发 16 位 PCM；给播放器的头把长度改成「未知」，它就会一直播到连接结束
    let head = Buffer.alloc(0), format = null, firstMs = 0, listening = true;
    const pcm = [];
    res.on('close', () => { listening = false; }); // 中途停声也把整句读完存进缓存，下次直接播
    for await (const chunk of response.body) {
      let bytes = Buffer.from(chunk);
      if (!format) {
        head = Buffer.concat([head, bytes]);
        const dataAt = head.indexOf('data', 12);
        if (head.toString('ascii', 0, 4) !== 'RIFF' && head.length >= 4) return fail('语音服务返回的不是 WAV');
        if (dataAt < 0 || head.length < dataAt + 8) continue;
        format = Buffer.from(head.subarray(0, dataAt + 8));
        bytes = head.subarray(dataAt + 8);
        const open = Buffer.from(format);
        open.writeUInt32LE(0xffffffff, 4);
        open.writeUInt32LE(0xffffffff, dataAt + 4);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (listening) res.write(open);
        firstMs = Date.now() - started;
      }
      if (bytes.length) {
        pcm.push(bytes);
        if (listening) res.write(bytes);
      }
    }
    if (!format) return fail('语音服务没有返回音频');
    if (listening) res.end();
    const data = Buffer.concat(pcm);
    const wav = Buffer.concat([format, data]);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt32LE(data.length, format.length - 4);
    writeFileSafe(file, wav);
    this.prune();
    this.log('voice', `stream ${text.length} chars: first audio ${firstMs} ms, done ${Date.now() - started} ms`);
  }

  prune() {
    try {
      const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith('.wav'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.cacheDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of files.slice(CACHE_LIMIT)) fs.rmSync(path.join(this.cacheDir, f), { force: true });
    } catch {}
  }
}

/** WAV 时长（毫秒）：按 RIFF 头里的字节率计算，读不出时返回 0。 */
function wavMs(bytes) {
  try {
    let offset = 12, byteRate = 0;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
      if (id === 'fmt ') byteRate = bytes.readUInt32LE(offset + 16);
      if (id === 'data') return byteRate ? Math.round((Math.min(size, bytes.length - offset - 8) / byteRate) * 1000) : 0;
      offset += 8 + size + (size % 2);
    }
  } catch {}
  return 0;
}

module.exports = { VoiceService, wavMs };
