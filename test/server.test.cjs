'use strict';
// 起一个真实的陪伴服务（临时数据目录、随机端口、关闭语音自启），检查静态叠加、注入与本机校验。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-companion-'));
const port = 19000 + Math.floor(Math.random() * 800);
const origin = `http://127.0.0.1:${port}`;
let child;

test.before(async () => {
  const s = require('../lib/settings.cjs').defaults();
  s.voice.autoStart = false;
  s.voice.url = 'http://127.0.0.1:9'; // 不连接真实语音服务
  s.greeting = false;
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(s));
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.cjs')], { env: { ...process.env, YUEXIA_COMPANION_HOME: home, YUEXIA_COMPANION_PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(origin + '/health')).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
});

test.after(() => {
  child?.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

const write = { 'content-type': 'application/json', 'x-yuexia-companion': '1' };

test('preview.html 来自动作包并追加陪伴脚本', async (t) => {
  // 源码仓库不带动作包：把发行版的 pet 文件夹放到仓库根目录后这一项才能运行
  const state = await (await fetch(origin + '/api/state')).json();
  if (!state.base.ok) return t.skip('没有动作包（pet 文件夹）');
  const html = await (await fetch(origin + '/preview.html?desktop=1')).text();
  assert.match(html, /CoffinPlayer/);
  assert.match(html, /\/companion\/pet-hook\.js/);
  const manifest = await (await fetch(origin + '/manifest.json')).json();
  assert.ok(manifest.id);
  assert.equal((await fetch(origin + '/companion/console.html')).status, 200);
});

test('目录穿越与外部 Host 被拒绝', async () => {
  assert.equal((await fetch(origin + '/companion/..%2f..%2fserver.cjs')).status, 403);
  assert.equal((await fetch(origin + '/..%2f..%2f..%2fwindows%2fwin.ini')).status, 403);
  const http = require('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
});

test('写操作需要自定义请求头，外站 Origin 被拒绝', async () => {
  assert.equal((await fetch(origin + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/api/settings', { method: 'PUT', headers: { ...write, origin: 'https://evil.example' }, body: '{}' })).status, 403);
});

test('设置保存后公开状态不含密钥，联动可切换', async () => {
  let state = await (await fetch(origin + '/api/settings', { method: 'PUT', headers: write, body: JSON.stringify({ link: 'codex', chat: { apiKey: 'sk-secret-value-123456' } }) })).json();
  assert.equal(state.settings.link, 'codex');
  assert.equal(state.settings.chat.hasApiKey, true);
  assert.ok(!JSON.stringify(state).includes('secret-value'));
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
  assert.equal(saved.chat.apiKey, 'sk-secret-value-123456');
  state = await (await fetch(origin + '/api/state')).json();
  assert.ok(['watching', 'missing', 'starting'].includes(state.codex.status));
  await fetch(origin + '/api/settings', { method: 'PUT', headers: write, body: JSON.stringify({ link: 'none' }) });
});

test('对话未就绪时给出中文原因，不写记录', async () => {
  await fetch(origin + '/api/settings', { method: 'PUT', headers: write, body: JSON.stringify({ chat: { clearApiKey: true } }) });
  const result = await (await fetch(origin + '/api/chat', { method: 'POST', headers: write, body: JSON.stringify({ text: '你好' }) })).json();
  assert.equal(result.ok, false);
  assert.match(result.message, /密钥/);
  assert.deepEqual((await (await fetch(origin + '/api/chat')).json()).messages, []);
});

test('SSE 推送 say 事件；语音不可用时推送 audio-error', async () => {
  const controller = new AbortController();
  const response = await fetch(origin + '/api/events', { signal: controller.signal });
  const reader = response.body.getReader();
  let buffer = '';
  const until = async (pattern) => {
    while (!pattern.test(buffer)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += Buffer.from(value).toString('utf8');
    }
  };
  await until(/event: state/);
  await fetch(origin + '/api/say', { method: 'POST', headers: write, body: JSON.stringify({ text: '今晚的月亮很好看哦。', emotion: 'happy' }) });
  await until(/event: say[\s\S]*event: audio-error/);
  assert.match(buffer, /今晚的月亮很好看哦/);
  controller.abort();
});
