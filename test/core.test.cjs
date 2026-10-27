'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = require('../lib/settings.cjs');
const persona = require('../lib/persona.cjs');
const { SessionReducer, CodexWatcher, cleanTitle, sessionIdOf } = require('../lib/codex.cjs');
const zlib = require('node:zlib');
const { DshWatcher, DshSession, decodeFrames } = require('../lib/dsh.cjs');
const { wavMs } = require('../lib/voice.cjs');

test('settings: 非法值回落、密钥空串不覆盖、可显式清除、公开视图不含密钥', () => {
  const base = settings.defaults();
  const n = settings.normalize({ link: 'hack', voice: { speed: 9, url: 'file:///c:/x' }, chat: { baseUrl: 'https://api.example.com/v1/?q=1' } }, base);
  assert.equal(n.link, 'none');
  const migrated = settings.normalize({ codex: { home: 'X', speakStart: false } }, base);
  assert.equal(migrated.work.speakStart, false, '旧版 codex 里的提醒开关迁移到 work');
  assert.equal(migrated.codex.home, 'X');
  assert.equal(settings.normalize({ chat: { provider: 'dsh' } }, base).chat.provider, 'openai', '已移除 dsh 对话通道');
  assert.equal(n.voice.speed, 1.5);
  assert.equal(n.voice.url, base.voice.url);
  assert.equal(n.chat.baseUrl, 'https://api.example.com/v1');
  const withKey = settings.merge(base, { chat: { apiKey: 'sk-1234567890abcdef' } });
  assert.equal(withKey.chat.apiKey, 'sk-1234567890abcdef');
  assert.equal(settings.merge(withKey, { chat: { model: 'm' } }).chat.apiKey, 'sk-1234567890abcdef');
  assert.equal(settings.merge(withKey, { chat: { apiKey: '' } }).chat.apiKey, 'sk-1234567890abcdef');
  assert.equal(settings.merge(withKey, { chat: { clearApiKey: true } }).chat.apiKey, '');
  const view = settings.publicView(withKey);
  assert.equal(view.chat.apiKey, undefined);
  assert.equal(view.chat.hasApiKey, true);
  assert.ok(!JSON.stringify(view).includes('1234567890abcdef'));
});

test('persona: 解析语气标签、去掉推理与句中标签', () => {
  assert.deepEqual(persona.parseReply('[shy]你、你看什么……'), { text: '你、你看什么……', emotion: 'shy' });
  assert.deepEqual(persona.parseReply('<think>想一想</think>【happy】好呀！[happy]'), { text: '好呀！', emotion: 'happy' });
  assert.deepEqual(persona.parseReply('没有标签'), { text: '没有标签', emotion: 'neutral' });
  assert.equal(persona.parseReply('[unknown]嗯').emotion, 'neutral');
});

test('persona: 合成文本去掉动作描写和表情，过长时在标点处截断', () => {
  assert.equal(persona.speakable('（歪头）你好呀😊'), '你好呀');
  const long = '一二三四五六七八九十，'.repeat(12);
  const spoken = persona.speakable(long, 50);
  assert.ok(spoken.length <= 50 && spoken.endsWith('，'));
  assert.match(persona.systemPrompt(''), /月下[\s\S]*现在是\d{4}年/);
});

test('codex: 归约器按生命周期发事件，子代理与历史不提醒', () => {
  const r = new SessionReducer('s1');
  const ev = (type, payload) => r.apply({ type, payload, timestamp: '2026-10-24T01:00:00Z' }, false);
  assert.deepEqual(ev('session_meta', { id: 's1' }), []);
  assert.equal(ev('event_msg', { type: 'task_started', turn_id: 't' })[0].kind, 'start');
  ev('event_msg', { type: 'user_message', message: '<environment_context>x</environment_context>帮我修一下登录页面的样式问题' });
  assert.equal(r.title, '帮我修一下登录页面的样式问题');
  const act = ev('response_item', { type: 'custom_tool_call', name: 'apply_patch' });
  assert.equal(act[0].kind, 'activity');
  assert.equal(act[0].label, '正在编辑文件');
  assert.deepEqual(ev('response_item', { type: 'custom_tool_call', name: 'apply_patch' }), [], '同一种操作不重复');
  assert.equal(ev('response_item', { type: 'function_call', name: 'shell_command' })[0].label, '正在运行命令');
  const done = ev('event_msg', { type: 'task_complete' });
  assert.equal(done[0].kind, 'complete');
  assert.equal(done[0].title, '帮我修一下登录页面的样式问题');
  assert.deepEqual(ev('event_msg', { type: 'task_complete' }), [], '完成只提醒一次');

  const child = new SessionReducer('s2');
  child.apply({ type: 'session_meta', payload: { id: 's2', source: { subagent: { thread_spawn: {} } } } }, false);
  assert.deepEqual(child.apply({ type: 'event_msg', payload: { type: 'task_started' } }, false), []);

  const old = new SessionReducer('s3');
  assert.deepEqual(old.apply({ type: 'event_msg', payload: { type: 'task_started' } }, true), []);
  assert.equal(old.state, 'thinking');
});

test('codex: 标题清理隐藏凭据，会话 id 取自文件名', () => {
  assert.equal(cleanTitle('用 sk-abcdefghijklmnopqrstu 调接口'), '用 [已隐藏] 调接口');
  assert.equal(sessionIdOf('rollout-2026-10-24T06-47-34-01a16d85-e6de-7162-8fd7-903134da205a.jsonl'), '01a16d85-e6de-7162-8fd7-903134da205a');
  assert.equal(sessionIdOf('rollout-2026-10-24T05-18-15-01a16d32-f7c8-75a2-85fd-c94ec0a56c8f_01a16d34-2019-7892-adc9-cffd8be7e294.jsonl'), '01a16d32-f7c8-75a2-85fd-c94ec0a56c8f');
});

test('codex: 监视器只对新增内容提醒，启动后新建的会话从头读取', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-codex-'));
  const day = path.join(home, 'sessions', '2026', '10', '24');
  fs.mkdirSync(day, { recursive: true });
  const line = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n';
  const oldFile = path.join(day, 'rollout-2026-10-24T01-00-00-11111111-1111-1111-1111-111111111111.jsonl');
  fs.writeFileSync(oldFile, line('session_meta', { id: '11111111-1111-1111-1111-111111111111' }) + line('event_msg', { type: 'task_started' }) + line('event_msg', { type: 'task_complete' }));
  const events = [];
  const watcher = new CodexWatcher({ getSettings: () => ({ codex: { home } }), onEvent: (e) => events.push(e) });
  watcher.start();
  try {
  watcher.poll();
  assert.deepEqual(events, [], '已有的历史不补发提醒');
  fs.appendFileSync(oldFile, line('event_msg', { type: 'task_started' }));
  watcher.poll();
  assert.deepEqual(events.map((e) => e.kind), ['start']);
  watcher.startedAt -= 5000; // 模拟桌宠已运行一段时间，之后新建的会话应从头读取
  const fresh = path.join(day, 'rollout-2026-10-24T02-00-00-22222222-2222-2222-2222-222222222222.jsonl');
  fs.writeFileSync(fresh, line('session_meta', { id: '22222222-2222-2222-2222-222222222222' }) + line('event_msg', { type: 'task_started' }) + line('event_msg', { type: 'user_message', message: '新会话' }));
  watcher.lastScan = 0;
  watcher.poll();
  assert.deepEqual(events.map((e) => e.kind), ['start', 'start']);
  const snap = watcher.snapshot();
  assert.equal(snap.status, 'watching');
  assert.equal(snap.active, 2);
  } finally {
    watcher.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dsh: zstd 帧逐段解码，未写完的帧留到下次', () => {
  const frames = ['{"a":1}\n', '{"b":2}\n'].map((t) => zlib.zstdCompressSync(Buffer.from(t)));
  const whole = Buffer.concat(frames);
  assert.equal(decodeFrames(whole, true).text, '{"a":1}\n{"b":2}\n');
  assert.equal(decodeFrames(whole).text, '{"a":1}\n', '文件还在增长时，最后一帧等下一帧出现再解');
  const partial = decodeFrames(whole.subarray(0, whole.length - 3));
  assert.equal(partial.text, '{"a":1}\n');
  assert.equal(partial.consumed, frames[0].length);
});

test('dsh: 会话归约按 turn 生命周期提醒，子代理不提醒', () => {
  const s = new DshSession('session-1');
  const ev = (type, data) => s.apply({ type, time: Date.now(), data }, false);
  s.apply({ type: 'session', delegationDepth: 0, createdAt: 1 }, false);
  ev('session/title', { title: '帮我配置反向代理' });
  assert.equal(ev('turn/start', { turn: 1 })[0].kind, 'start');
  assert.equal(ev('tool/call', { name: 'run_code' })[0].label, '正在运行命令');
  const done = ev('turn/end', { reason: { kind: 'completed' } });
  assert.equal(done[0].kind, 'complete');
  assert.equal(done[0].title, '帮我配置反向代理');
  ev('turn/start', { turn: 2 });
  assert.equal(ev('turn/end', { reason: { kind: 'error' } })[0].kind, 'error');
  ev('turn/start', { turn: 3 });
  assert.equal(ev('turn/end', { reason: { kind: 'aborted' } })[0].kind, 'abort');
  const child = new DshSession('session-2');
  child.apply({ type: 'session', delegationDepth: 1 }, false);
  assert.deepEqual(child.apply({ type: 'turn/start', data: {} }, false), []);
});

test('dsh: 监视器读本机会话文件，只对新增内容提醒', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-dsh-'));
  const frame = (o) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(o) + '\n'));
  const dir = path.join(home, 'sessions', '--workspace--', 'session-aaa');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, Buffer.concat([frame({ type: 'session', delegationDepth: 0 }), frame({ type: 'turn/start', data: { turn: 1 } }), frame({ type: 'turn/end', data: { reason: { kind: 'completed' } } })]));
  const events = [];
  const w = new DshWatcher({ getSettings: () => ({ dsh: { home } }), onEvent: (e) => events.push(e) });
  w.startedAt = Date.now() + 1000; // 视作启动前就存在的会话
  w.lastScan = 0;
  w.timer = 1;
  w.poll();
  w.poll();
  assert.deepEqual(events, [], '已有的历史不补发提醒');
  fs.appendFileSync(file, Buffer.concat([frame({ type: 'session/title', data: { title: '新任务' } }), frame({ type: 'turn/start', data: { turn: 2 } })]));
  w.poll();
  w.poll(); // 第二轮文件没再增长，最后一帧才算写完
  assert.deepEqual(events.map((e) => e.kind), ['start']);
  assert.equal(events[0].title, '新任务');
  assert.equal(w.snapshot().active, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('voice: 按 RIFF 头计算 WAV 时长', () => {
  const rate = 32000, seconds = 1.5, data = Buffer.alloc(rate * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  assert.equal(wavMs(Buffer.concat([header, data])), 1500);
  assert.equal(wavMs(Buffer.from('nope')), 0);
});

test('gpu: 只改 custom 段的 device / is_half，其他版本段不动', () => {
  const { deviceConfig } = require('../lib/gpu.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-gpu-'));
  const src = path.join(dir, 'in.yaml');
  fs.writeFileSync(src, 'custom:\n  device: cpu\n  is_half: false\n  version: v2Pro\nv1:\n  device: cpu\n  is_half: false\n');
  const out = fs.readFileSync(deviceConfig(src, path.join(dir, 'out.yaml'), { device: 'cuda', half: true }), 'utf8');
  assert.equal(out, 'custom:\n  device: cuda\n  is_half: true\n  version: v2Pro\nv1:\n  device: cpu\n  is_half: false\n');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('codex-agent: 解析 app-server 消息，转交批准请求，完成后清理', () => {
  const { CodexAgent, quotaWindows } = require('../lib/codex-agent.cjs');
  const events = [], sent = [];
  const a = new CodexAgent({ getSettings: () => ({ codex: { sandbox: 'workspace-write' } }), onEvent: (e) => events.push(e) });
  a.proc = { stdin: { write: (line) => sent.push(JSON.parse(line)) } };
  a.thread = { id: 't1', cwd: 'D:/x' };
  a.turn = 'u1';
  const feed = (o) => a.receive(JSON.stringify(o) + '\n');
  feed({ method: 'item/started', params: { threadId: 't1', item: { type: 'commandExecution' } } });
  feed({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', command: 'npm test', cwd: 'D:/x' } });
  feed({ method: 'item/completed', params: { threadId: 't1', item: { type: 'agentMessage', id: 'm', text: '改好了', phase: 'final_answer' } } });
  feed({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', id: 'z', text: '别的对话' } } });
  assert.deepEqual(events.map((e) => e.kind), ['progress', 'approval', 'message']);
  assert.equal(events[1].approval.command, 'npm test');
  assert.ok(a.answer(events[1].approval.id, true));
  assert.deepEqual(sent.pop(), { id: 7, result: { decision: 'accept' } });
  feed({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
  assert.equal(events.at(-1).kind, 'done');
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(a.turn, null);
  assert.deepEqual(quotaWindows({ primary: { usedPercent: 32, windowDurationMins: 300, resetsAt: 100 }, secondary: { usedPercent: 18, windowDurationMins: 10080 } }).map((w) => [w.name, w.remaining]), [['5小时', 68], ['一周', 82]]);
});

test('tasks: 派活写进当前会话并记住对话 ID，自己派出的会话不重复提醒', async () => {
  const { Tasks } = require('../lib/tasks.cjs');
  const { Conversations } = require('../lib/conversations.cjs');
  const said = [];
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-task-data-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-task-'));
  const conversations = new Conversations({ dataDir: data });
  const settings = { codex: { workdir: dir, sandbox: 'read-only' }, dsh: { workdir: '' }, chat: {} };
  const t = new Tasks({ getSettings: () => settings, conversations, speech: { say: (x) => said.push(x) }, broadcast: () => {} });
  const calls = [];
  t.agents.codex.dispatch = async (text, cwd, threadId) => { calls.push(threadId); t.onAgent({ target: 'codex', kind: 'started', threadId: 'thread-1' }); };
  await t.dispatch('codex', '改一下 README');
  const conv = conversations.active('codex');
  assert.ok(t.own.has('thread-1'));
  assert.equal(conv.threadId, 'thread-1');
  assert.equal(conv.cwd, dir);
  assert.equal(conv.title, '改一下 README', '第一句话成为会话标题');
  assert.match(said[0].text, /交给Codex/);
  // 任务进行中切到新会话：结果仍写回派出时的那个会话
  conversations.create('codex');
  t.onAgent({ target: 'codex', kind: 'message', text: '已修改 README', final: true });
  t.onAgent({ target: 'codex', kind: 'done', status: 'completed' });
  assert.deepEqual(conversations.messages(conv.id).map((m) => [m.role, m.text]), [['user', '改一下 README'], ['assistant', '已修改 README']]);
  assert.equal(conversations.messages(conversations.active('codex').id).length, 0);
  assert.match(said.at(-1).text, /做完了/);
  // 切回旧会话继续：带上它的 threadId
  conversations.activate(conv.id);
  await t.dispatch('codex', '再检查一遍');
  assert.deepEqual(calls, [null, 'thread-1']);
  t.onAgent({ target: 'codex', kind: 'done', status: 'failed', usageLimit: true, error: 'Codex 额度已用完' });
  assert.match(said.at(-1).text, /额度用完/);
  await assert.rejects(() => t.dispatch('dsh', '做点事'), /任务目录/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(data, { recursive: true, force: true });
});

test('conversations: 新建、切换、改名、删除，旧版记录按类型迁移', () => {
  const { Conversations } = require('../lib/conversations.cjs');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'yuexia-conv-'));
  fs.writeFileSync(path.join(data, 'chat-history.json'), JSON.stringify([
    { id: 'a', ts: 1, role: 'user', channel: 'chat', text: '你好' },
    { id: 'b', ts: 2, role: 'assistant', channel: 'chat', text: '人类，你好' },
    { id: 'c', ts: 3, role: 'user', channel: 'dsh', text: '读一下文件' },
  ]));
  const c = new Conversations({ dataDir: data });
  assert.deepEqual(c.list().map((x) => [x.target, x.title, x.count]).sort(), [['chat', '你好', 2], ['dsh', '读一下文件', 1]]);
  const first = c.active('chat');
  const empty = c.create('chat');
  assert.notEqual(empty.id, first.id);
  assert.equal(c.create('chat').id, empty.id, '空会话不重复新建');
  c.append(empty.id, { role: 'user', text: '今天天气怎么样呀，适合出去走走吗？我想去公园' });
  assert.match(c.get(empty.id).title, /^今天天气怎么样/);
  c.rename(empty.id, '  天气  ');
  assert.equal(c.get(empty.id).title, '天气');
  assert.throws(() => c.rename(empty.id, '   '), /不能为空/);
  c.activate(first.id);
  assert.equal(c.active('chat').id, first.id);
  assert.ok(c.remove(first.id));
  assert.equal(c.active('chat').id, empty.id, '删除当前会话后切到最近的一条');
  const again = new Conversations({ dataDir: data });
  assert.equal(again.get(empty.id).title, '天气', '重启后仍在');
  assert.equal(again.messages(empty.id).length, 1);
  assert.equal(c.active('codex').target, 'codex', '没有会话时自动新建');
  fs.rmSync(data, { recursive: true, force: true });
});

test('steps: Codex 每一项原样转成步骤，命令带输出与退出码', () => {
  const { stepOf, CodexAgent } = require('../lib/codex-agent.cjs');
  const cmd = stepOf({ type: 'commandExecution', command: 'npm test', aggregatedOutput: '2 passing\n', exitCode: 0, status: 'completed', cwd: 'D:/x' });
  assert.deepEqual([cmd.type, cmd.title, cmd.detail, cmd.exitCode, cmd.status], ['command', 'npm test', '2 passing\n', 0, 'ok']);
  assert.equal(stepOf({ type: 'commandExecution', command: 'false', aggregatedOutput: '', exitCode: 1 }).status, 'error');
  const file = stepOf({ type: 'fileChange', changes: [{ path: 'D:/x/README.md', kind: 'update', diff: '-a\n+b' }], status: 'completed' });
  assert.match(file.title, /1 个文件：README\.md/);
  assert.match(file.detail, /--- D:\/x\/README\.md（update）\n-a\n\+b/);
  assert.equal(stepOf({ type: 'reasoning', summary: [], content: [] }), null);
  assert.equal(stepOf({ type: 'reasoning', summary: ['先看目录'], content: [] }).detail, '先看目录');
  assert.ok(stepOf({ type: 'commandExecution', command: 'x', aggregatedOutput: 'y'.repeat(25000), exitCode: 0 }).detail.includes('省略'));
  // 中途说明记成步骤，最终回答不记
  const events = [];
  const a = new CodexAgent({ getSettings: () => ({ codex: {} }), onEvent: (e) => events.push(e) });
  a.thread = { id: 't' };
  a.notification('item/completed', { threadId: 't', item: { type: 'agentMessage', id: '1', text: '我先看看', phase: 'commentary' } });
  a.notification('item/completed', { threadId: 't', item: { type: 'commandExecution', command: 'dir', aggregatedOutput: 'a', exitCode: 0 } });
  a.notification('item/completed', { threadId: 't', item: { type: 'agentMessage', id: '2', text: '完成', phase: 'final_answer' } });
  assert.deepEqual(events.filter((e) => e.kind === 'step').map((e) => [e.step.n, e.step.type]), [[1, 'text'], [2, 'command']]);
});

test('steps: DSH 工具标题取 description，其次是命令', () => {
  const { toolTitle } = require('../lib/dsh-agent.cjs');
  assert.equal(toolTitle('pwsh', { description: '列出目录', command: 'ls' }), 'pwsh：列出目录');
  assert.equal(toolTitle('pwsh', { command: 'Get-ChildItem\nmore' }), 'pwsh：Get-ChildItem');
  assert.equal(toolTitle('read', null), 'read');
});
