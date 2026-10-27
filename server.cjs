'use strict';
// 月下陪伴版本地服务（只监听 127.0.0.1）。
//  · 静态文件：/companion/* 来自本目录 web/；其余来自设置里的月下动作包（默认摩天轮包），
//    preview.html 在返回时追加陪伴脚本，原包文件不做任何修改。
//  · /api/*：设置、对话、语音、Codex / DSH 联动状态，/api/events 为 SSE 实时事件。
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const settingsStore = require('./lib/settings.cjs');
const persona = require('./lib/persona.cjs');
const { VoiceService } = require('./lib/voice.cjs');
const { ChatService } = require('./lib/chat.cjs');
const { Conversations } = require('./lib/conversations.cjs');
const { CodexWatcher } = require('./lib/codex.cjs');
const { DshWatcher } = require('./lib/dsh.cjs');
const { Speech } = require('./lib/speech.cjs');
const { Tasks } = require('./lib/tasks.cjs');
const { UsageStats } = require('./lib/usage.cjs');

const PORT = Number(process.env.YUEXIA_COMPANION_PORT || 18766);
const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const VERSION = '1.0.0';
const HOOK = '\n<script type="module" src="/companion/pet-hook.js"></script>\n';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webp': 'image/webp', '.webm': 'video/webm', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

let settings = settingsStore.load();
const getSettings = () => settings;
fs.mkdirSync(settingsStore.DATA_DIR, { recursive: true });
const logFile = path.join(settingsStore.DATA_DIR, 'companion.log');
function log(scope, message) {
  const line = `${new Date().toISOString()} [${scope}] ${message}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
let lastClientAt = Date.now();
let greeted = false; // 每次启动只在月下第一次进入待机时问候一次
function broadcast(event, data) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(packet);
}

const voice = new VoiceService({ dataDir: settingsStore.DATA_DIR, getSettings, log });
const conversations = new Conversations({ dataDir: settingsStore.DATA_DIR });
const chat = new ChatService({ getSettings, conversations });
const speech = new Speech({ voice, getSettings, broadcast, log });
const usage = new UsageStats({ dataDir: settingsStore.DATA_DIR, getSettings, log });
const tasks = new Tasks({ getSettings, conversations, speech, broadcast, log, onQuota: (q) => { quota.codex = q; broadcast('quota', quota); } });
const onWork = (event) => {
  broadcast('work', event);
  // 两边日志都在读（状态卡要显示），但只有“联动”选中的工具会让月下出声；她自己派出的任务由派活调度负责说话
  const from = event.source === 'dsh' ? 'dsh' : 'codex';
  if (settings.link === from && !tasks.own.has(event.session)) speech.work(event);
  broadcast('state', state());
};
const codex = new CodexWatcher({ getSettings, onEvent: onWork, log });
const dsh = new DshWatcher({ getSettings, onEvent: onWork, log });
voice.onChange((snapshot) => {
  broadcast('voice', snapshot);
  if (snapshot.state === 'ready') void speech.prewarm(() => chat.busy);
});

function applyLink() {
  // 状态卡可以随时切换查看 Codex / DSH，所以两边的本机日志都读；是否出声由 onWork 按联动设置决定
  codex.start();
  dsh.start();
}

// 卡片上显示的额度：Codex 5 小时 / 每周剩余（经 codex app-server），DeepSeek 官方账户余额
const quota = { codex: null, deepseek: null, error: {}, checked: false };
let quotaAt = 0;
async function refreshQuota(force = false) {
  if (!force && Date.now() - quotaAt < 5 * 60 * 1000) return quota;
  quotaAt = Date.now();
  await Promise.all([
    tasks.agents.codex.readQuota().then((q) => { quota.codex = q; delete quota.error.codex; }).catch((e) => { quota.error.codex = e.message; }),
    chat.balance().then((b) => { quota.deepseek = b; delete quota.error.deepseek; }).catch((e) => { quota.error.deepseek = e.message; }),
  ]);
  quota.checked = true;
  broadcast('quota', quota);
  return quota;
}

function basePackage() {
  const dir = settingsStore.petDir(settings);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    return { path: dir, ok: true, id: manifest.id, name: manifest.name, layout: manifest.layout || null };
  } catch {
    return { path: dir, ok: false, id: null, name: null, layout: null };
  }
}

function state() {
  return {
    version: VERSION,
    settings: settingsStore.publicView(settings),
    voice: voice.snapshot(),
    chat: { ...chat.status(), busy: chat.busy },
    codex: codex.snapshot(),
    dsh: dsh.snapshot(),
    pet: { phase: speech.petPhase },
    tasks: tasks.snapshot(),
    quota,
    base: basePackage(),
    dataDir: settingsStore.DATA_DIR,
    defaultPersona: persona.DEFAULT_PERSONA,
    emotions: settingsStore.EMOTIONS,
  };
}

// ---------------------------------------------------------------- HTTP 工具
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求太大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file, inject = false) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { error: 'not-found' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    if (inject) {
      fs.readFile(file, 'utf8', (error, html) => {
        if (error) return send(res, 500, { error: 'read-failed' });
        send(res, 200, html + HOOK, type);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function inside(root, file) {
  const resolved = path.resolve(file);
  return resolved === root || resolved.startsWith(path.resolve(root) + path.sep);
}

// 只接受本机来源：Host 必须是本服务自己，写操作还需自定义请求头（跨站页面无法在不预检的情况下带上）
function trusted(req, write) {
  const host = String(req.headers.host || '');
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  return !write || req.headers['x-yuexia-companion'] === '1';
}

// ---------------------------------------------------------------- API
async function api(req, res, url) {
  const method = req.method;
  const route = url.pathname.slice(4);
  const write = method !== 'GET' && method !== 'HEAD';
  if (!trusted(req, write)) return send(res, 403, { error: 'forbidden' });
  try {
    if (route === '/state' && method === 'GET') return send(res, 200, state());
    if (route === '/events' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      lastClientAt = Date.now();
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); lastClientAt = Date.now(); });
      return;
    }
    if (route === '/settings' && method === 'PUT') {
      const previous = settings;
      const next = settingsStore.merge(settings, await readJson(req));
      settingsStore.save(next); // 写盘失败时保持原设置不变
      settings = next;
      if (previous.link !== settings.link || previous.codex.home !== settings.codex.home || previous.dsh.home !== settings.dsh.home) { codex.stop(); dsh.stop(); applyLink(); }
      if (previous.voice.url !== settings.voice.url || previous.voice.profile !== settings.voice.profile) { speech.prewarmed = false; void voice.refresh(); }
      if (settings.voice.enabled && settings.voice.autoStart && !previous.voice.enabled) void voice.start();
      if (previous.voice.device !== settings.voice.device && voice.child) void voice.stop().then(() => voice.start());
      broadcast('state', state());
      return send(res, 200, state());
    }
    // ---- 会话管理（闲聊 / Codex / DSH 各一组）
    if (route === '/conversations' && method === 'GET') {
      const target = url.searchParams.get('target');
      const list = conversations.list(['chat', 'codex', 'dsh'].includes(target) ? target : null);
      return send(res, 200, { list, active: Object.fromEntries(['chat', 'codex', 'dsh'].map((t) => [t, conversations.active(t).id])) });
    }
    if (route === '/conversations' && method === 'POST') {
      const conv = conversations.create(String((await readJson(req)).target || ''));
      broadcast('conversations', { changed: conv.id });
      return send(res, 200, { ok: true, conversation: conv });
    }
    const convRoute = route.match(/^\/conversations\/([0-9a-f-]{36})(\/messages|\/activate|\/open)?$/);
    if (convRoute) {
      const [, id, action] = convRoute;
      if (!conversations.get(id)) return send(res, 200, { ok: false, message: '找不到这个会话' });
      if (action === '/messages' && method === 'GET') return send(res, 200, { ok: true, conversation: conversations.get(id), messages: conversations.messages(id).slice(-400) });
      if (action === '/activate' && method === 'POST') {
        const conv = conversations.activate(id);
        broadcast('conversations', { changed: id });
        return send(res, 200, { ok: true, conversation: conv });
      }
      if (action === '/open' && method === 'POST') {
        // 用 Codex 自己的会话链接打开（与白龙相同）：Codex 会从磁盘读出这个对话，不用重启
        const conv = conversations.get(id);
        if (conv.target !== 'codex' || !/^[0-9a-f-]{36}$/.test(conv.threadId || '')) return send(res, 200, { ok: false, message: '这个会话还没有对应的 Codex 对话' });
        require('node:child_process').spawn('cmd', ['/c', 'start', '', 'codex://threads/' + conv.threadId], { windowsHide: true, stdio: 'ignore', detached: true }).unref();
        return send(res, 200, { ok: true });
      }
      if (!action && method === 'PUT') {
        try {
          const conv = conversations.rename(id, (await readJson(req)).title);
          broadcast('conversations', { changed: id });
          return send(res, 200, { ok: true, conversation: conv });
        } catch (error) {
          return send(res, 200, { ok: false, message: error.message });
        }
      }
      if (!action && method === 'DELETE') {
        if (tasks.busy(id)) return send(res, 200, { ok: false, message: '这个会话还有任务在进行，先停止再删除' });
        conversations.remove(id);
        broadcast('conversations', { removed: id });
        return send(res, 200, { ok: true });
      }
    }
    if (route === '/chat' && method === 'GET') return send(res, 200, { messages: conversations.messages(conversations.active('chat').id).slice(-100), busy: chat.busy });
    if (route === '/chat' && method === 'DELETE') {
      conversations.clear(conversations.active('chat').id);
      broadcast('conversations', {});
      return send(res, 200, { ok: true });
    }
    if (route === '/chat' && method === 'POST') {
      const body = await readJson(req);
      broadcast('chat-pending', { text: String(body.text || '').slice(0, 2000) });
      const started = Date.now();
      try {
        const reply = await chat.send(body.text);
        log('chat', `reply in ${Date.now() - started} ms`);
        broadcast('chat', { conversation: reply.conversation, reply });
        broadcast('conversations', { changed: reply.conversation });
        const said = speech.say({ text: reply.text, emotion: reply.emotion, source: 'chat' });
        return send(res, 200, { ok: true, reply, sayId: said?.id || null });
      } catch (error) {
        log('chat', `failed after ${Date.now() - started} ms: ${error.message}`);
        broadcast('chat-error', { message: error.message });
        return send(res, 200, { ok: false, message: error.message });
      }
    }
    if (route === '/task' && method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      try {
        const message = await tasks.dispatch(body.target, body.text);
        broadcast('conversations', {});
        return send(res, 200, { ok: true, message });
      } catch (error) {
        return send(res, 200, { ok: false, message: error.message });
      }
    }
    if (route === '/task/approve' && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { ok: tasks.answer(body.target, String(body.id || ''), body.accept === true) });
    }
    if (route === '/task/interrupt' && method === 'POST') return send(res, 200, { ok: await tasks.interrupt((await readJson(req)).target) });
    if (route === '/task/new' && method === 'POST') {
      const conv = conversations.create(String((await readJson(req)).target || ''));
      broadcast('conversations', { changed: conv.id });
      return send(res, 200, { ok: true, conversation: conv });
    }
    if (route === '/usage' && method === 'GET') {
      const source = ['codex', 'dsh', 'all'].includes(url.searchParams.get('source')) ? url.searchParams.get('source') : 'codex';
      // 先返回缓存结果，后台增量扫描完成后再推送 usage 事件
      void usage.refresh().then(() => broadcast('usage', { codex: usage.summary('codex'), dsh: usage.summary('dsh'), all: usage.summary('all') }));
      return send(res, 200, usage.summary(source));
    }
    if (route === '/quota' && method === 'GET') return send(res, 200, await refreshQuota(url.searchParams.get('force') === '1'));
    if (route === '/chat/models' && method === 'GET') return send(res, 200, { ok: true, models: await chat.models() });
    if (route === '/say' && method === 'POST') {
      const body = await readJson(req);
      const emotion = settingsStore.EMOTIONS.includes(body.emotion) ? body.emotion : 'neutral';
      const said = speech.say({ text: String(body.text || '').slice(0, 200), emotion, source: body.source === 'chat' ? 'chat' : 'test' });
      return send(res, 200, { ok: !!said, id: said?.id || null });
    }
    if (route === '/synth' && method === 'POST') {
      // 控制台“重播”：只合成（或取缓存）并返回音频地址，不广播到气泡
      const body = await readJson(req);
      const emotion = settingsStore.EMOTIONS.includes(body.emotion) ? body.emotion : 'neutral';
      const result = await voice.synthesize(persona.speakable(String(body.text || '').slice(0, 300)), emotion);
      return send(res, 200, { ok: true, url: `/api/audio/${result.key}.wav`, ms: result.ms });
    }
    if (route === '/voice/start' && method === 'POST') { void voice.start(); return send(res, 200, { ok: true, voice: voice.snapshot() }); }
    if (route === '/voice/stop' && method === 'POST') return send(res, 200, { ok: await voice.stop(), voice: voice.snapshot() });
    if (route === '/voice/refresh' && method === 'POST') { await voice.refresh(); return send(res, 200, { ok: true, voice: voice.snapshot() }); }
    const audio = route.match(/^\/audio\/([0-9a-f]{32})\.wav$/);
    if (audio && method === 'GET') return serveFile(res, voice.cachePath(audio[1]));
    // 流式语音：响应在合成过程中逐段写出，出错时已由 voice.pipe 结束响应，这里只记日志
    const stream = route.match(/^\/audio\/stream\/([0-9a-f]{32})\.wav$/);
    if (stream && method === 'GET') return voice.pipe(stream[1], res).catch((error) => log('voice', 'stream failed: ' + error.message));
    if (route === '/pet/phase' && method === 'POST') {
      const body = await readJson(req);
      const phase = String(body.phase || '').slice(0, 40);
      speech.petPhase = phase;
      broadcast('phase', { phase });
      if (phase === 'idle' && settings.greeting && !greeted) {
        greeted = true;
        setTimeout(() => speech.say({ ...persona.greeting(), source: 'work' }), 1500);
      }
      return send(res, 200, { ok: true });
    }
    if (route === '/shutdown' && method === 'POST') {
      send(res, 200, { ok: true });
      setTimeout(shutdown, 100);
      return;
    }
    return send(res, 404, { error: 'unknown-api' });
  } catch (error) {
    log('api', `${method} ${route}: ${error.message}`);
    return send(res, 200, { ok: false, message: error.message });
  }
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${PORT}`); } catch { return send(res, 400, { error: 'bad-url' }); }
  if (url.pathname.startsWith('/api/')) return void api(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
  if (!trusted(req, false)) return send(res, 403, { error: 'forbidden' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad-url' }); }
  if (pathname === '/health') return send(res, 200, { name: 'yuexia-companion', version: VERSION, port: PORT, base: basePackage().id });
  if (pathname.startsWith('/companion/')) {
    const file = path.join(WEB, pathname.slice('/companion/'.length));
    return inside(WEB, file) ? serveFile(res, file) : send(res, 403, { error: 'forbidden' });
  }
  const base = settingsStore.petDir(settings);
  const file = path.join(base, pathname === '/' ? 'preview.html' : pathname);
  if (!inside(base, file)) return send(res, 403, { error: 'forbidden' });
  return serveFile(res, file, path.basename(file) === 'preview.html');
});

function shutdown() {
  log('server', 'shutdown');
  codex.stop();
  dsh.stop();
  tasks.stop();
  for (const res of clients) res.end();
  void voice.stop().finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}

// 日志联动读历史时状态会变但不产生提醒事件：定时比较快照，变了就推送，卡片上的会话状态不会停在旧值
let lastLinkView = '';
setInterval(() => {
  if (!clients.size) return;
  const view = JSON.stringify([codex.snapshot(), dsh.snapshot()]);
  if (view !== lastLinkView) { lastLinkView = view; broadcast('state', state()); }
}, 3000).unref();

// 没有任何窗口连接 10 分钟后自行退出，避免桌宠关掉后留下后台服务和语音进程
setInterval(() => {
  if (!clients.size && Date.now() - lastClientAt > 10 * 60 * 1000) shutdown();
}, 60000).unref();

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  log('server', `listening ${PORT}, base ${settingsStore.petDir(settings)}`);
  console.log(`YUEXIA_COMPANION http://127.0.0.1:${PORT}/`);
  applyLink();
  void usage.refresh(); // 首次在后台分块扫描全部日志
  if (settings.voice.enabled && settings.voice.autoStart) void voice.start(); else void voice.refresh();
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
