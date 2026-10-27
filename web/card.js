// 月下卡片：精简对话框。闲聊走对话模型；切到 Codex / DSH 时，你的话由月下作为任务转交给对应工具。
// 三种各有自己的会话列表：新建、切换、改名、删除；记录只显示当前会话。
import { api, subscribe } from './api.js';

const $ = (s, root = document) => root.querySelector(s);
const bridge = window.companionBridge;
if (!bridge) document.body.classList.add('browser');

const NAME = { chat: '闲聊', codex: 'Codex', dsh: 'DSH' };
const PLACEHOLDER = {
  chat: '和月下说说话……（Enter 发送）',
  codex: '让月下交给 Codex 做什么？例如：把 README 里的错别字改掉',
  dsh: '让月下交给 DeepSeek Harness 做什么？',
};
const STATE = { thinking: '思考中', working: '工作中', responding: '整理回复', waiting: '等你批准', complete: '已完成', interrupted: '已中断' };

let state = null, messages = [], busyChat = false;
let convs = { list: [], active: {} }, drawerOpen = false;
const activeConv = () => convs.list.find((c) => c.id === convs.active[target()]) || null;
const log = $('#log');

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), ms);
}

const target = () => state?.settings.chatTarget || 'chat';
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function until(ms) {
  if (!ms) return '';
  const left = ms - Date.now();
  if (left <= 0) return '即将重置';
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  if (h >= 24) return Math.round(h / 24) + '天后重置';
  return h ? `${h}时${m}分后重置` : `${Math.max(1, m)}分钟后重置`;
}

// ---------------------------------------------------------------- 渲染
function renderHead() {
  for (const b of document.querySelectorAll('#targets button')) b.classList.toggle('on', b.dataset.target === target());
  const tasks = state.tasks;
  const working = tasks.codex.live.working || tasks.dsh.live.working || busyChat;
  const need = (tasks.codex.live.approvals || []).length > 0;
  $('#dot').className = 'dot ' + (need ? 'need' : working ? 'busy' : 'ok');
  $('#input').placeholder = PLACEHOLDER[target()];
  const t = target();
  $('#taskbar').hidden = t === 'chat';
  const conv = activeConv();
  $('#conv-name').textContent = conv ? conv.title + (conv.count ? '（' + conv.count + '）' : '') : '新会话';
  $('#convs').classList.toggle('open', drawerOpen);
  if (t !== 'chat') {
    // 已经开始过的会话固定在原来的目录里继续
    const locked = !!(conv && (conv.threadId || conv.sessionId) && conv.cwd);
    const dir = locked ? conv.cwd : state.settings[t].workdir;
    $('#folder-name').textContent = dir || '选择任务目录';
    $('#folder').classList.toggle('set', !!dir);
    $('#folder').classList.toggle('locked', locked);
    $('#folder').title = locked ? '这个会话固定在：' + dir + '（换目录请新建会话）' : dir ? '任务目录：' + dir + '（点击更换）' : '选择任务目录';
    $('#stop').hidden = !tasks[t].live.working;
    $('#open-codex').hidden = !(t === 'codex' && conv?.threadId);
  }
}

function renderStatus() {
  const rows = [];
  for (const t of ['codex', 'dsh']) {
    const live = state.tasks[t].live;
    if (live.working) rows.push([NAME[t] + ' · 月下派的活', live.progress || '处理中']);
  }
  const link = state.settings.link;
  if (link === 'codex' || link === 'dsh') {
    for (const s of state[link].sessions.filter((x) => x.active).slice(0, 2)) rows.push([s.title, s.label]);
    if (!rows.length && state[link].sessions[0]) rows.push([state[link].sessions[0].title, STATE[state[link].sessions[0].state] || '']);
  }
  const box = $('#sessions');
  box.replaceChildren(...rows.slice(0, 2).map(([title, label]) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = '<b></b><span></span>';
    $('b', row).textContent = title;
    $('span', row).textContent = label;
    return row;
  }));
  const q = state.quota || {};
  const windows = q.codex?.windows || [];
  for (const [id, name] of [['#m5h', '5小时'], ['#mweek', '一周']]) {
    const w = windows.find((x) => x.name === name), el = $(id);
    $('b', el).textContent = w ? w.remaining + '%' : '—';
    $('u', el).style.width = (w ? w.remaining : 0) + '%';
    $('small', el).textContent = w ? until(w.resetsAt) : q.error?.codex ? '读不到额度' : '未读取';
    el.classList.toggle('low', !!w && w.remaining <= 10);
    el.title = q.error?.codex || '';
  }
  const ds = q.deepseek, el = $('#mds');
  $('b', el).textContent = ds ? (ds.currency === 'CNY' ? '¥' : ds.currency + ' ') + ds.total.toFixed(2) : '—';
  $('small', el).textContent = ds ? (ds.available ? '账户余额' : '余额不足') : q.error?.deepseek ? '读取失败' : '未填密钥';
  el.classList.toggle('low', !!ds && !ds.available);
}

const toggled = new Map(); // 用户手动展开 / 收起过的步骤，重新渲染时保持
const STEP_KIND = { thinking: '思考', text: '说明', plan: '计划', command: '命令', file: '文件', search: '搜索', tool: '工具', note: '记录' };

function duration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return s >= 60 ? Math.floor(s / 60) + '分' + (s % 60) + '秒' : s + '秒';
}

/** Codex / DSH 的一步：说明与计划直接显示；其余折叠，点开看原样的内容。 */
function stepEl(m) {
  const el = document.createElement('div');
  el.className = 'step t-' + (m.type || 'tool') + (m.status === 'error' ? ' bad' : '');
  const head = document.createElement('button');
  head.className = 'sh';
  head.innerHTML = '<span class="n"></span><span class="k"></span><span class="tt"></span><span class="st"></span>';
  $('.n', head).textContent = m.n ? '步骤 ' + m.n : '';
  $('.k', head).textContent = STEP_KIND[m.type] || '步骤';
  $('.tt', head).textContent = m.type === 'thinking' ? (m.detail || '').replace(/\s+/g, ' ').slice(0, 60) : m.title;
  $('.st', head).textContent = m.type === 'command' && m.exitCode !== null && m.exitCode !== undefined ? (m.status === 'error' ? '✗ ' : '✓ ') + m.exitCode
    : m.status === 'error' ? '✗' : m.status === 'ok' ? '✓' : '';
  el.append(head);
  const open = toggled.has(m.id) ? toggled.get(m.id) : m.type === 'text' || m.type === 'plan';
  if (m.detail || m.cwd) {
    const body = document.createElement('pre');
    body.className = 'sd';
    body.textContent = (m.cwd ? '目录：' + m.cwd + '\n\n' : '') + (m.detail || '（没有输出）');
    body.hidden = !open;
    el.append(body);
    head.onclick = () => { body.hidden = !body.hidden; toggled.set(m.id, !body.hidden); el.classList.toggle('open', !body.hidden); };
    el.classList.toggle('open', open);
  } else {
    head.disabled = true;
  }
  return el;
}

function messageEl(m) {
  if (m.role === 'step') return stepEl(m);
  const el = document.createElement('div');
  el.className = 'msg ' + (m.role === 'user' ? 'user' : 'her') + (m.status === 'failed' ? ' failed' : '');
  el.innerHTML = '<div class="b"></div>';
  const b = $('.b', el);
  if (m.channel === 'codex' || m.channel === 'dsh') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.role === 'user' ? '交给 ' + NAME[m.channel] : NAME[m.channel] + (m.status === 'failed' ? ' · 未完成' : m.status === 'interrupted' ? ' · 已停止' : '');
    b.append(tag);
  }
  b.append(document.createTextNode(m.text));
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = clock(m.ts) + (m.steps ? ' · 共 ' + m.steps + ' 步' : '') + (m.durationMs ? ' · 用时 ' + duration(m.durationMs) : '');
  if (m.role === 'assistant' && (!m.channel || m.channel === 'chat')) {
    const replay = Object.assign(document.createElement('button'), { textContent: '▶' , title: '重听' });
    replay.onclick = () => replayVoice(m);
    meta.append(replay);
  }
  b.append(meta);
  return el;
}

function liveEls() {
  const out = [];
  if (busyChat) {
    const el = document.createElement('div');
    el.className = 'msg her';
    el.innerHTML = '<div class="b"><span class="typing"><i></i><i></i><i></i></span></div>';
    out.push(el);
  }
  for (const t of ['codex', 'dsh']) {
    const live = state.tasks[t].live;
    // 只在正在看的那个会话里显示进度与批准
    if (!live.working || t !== target() || (state.tasks[t].running && state.tasks[t].running !== convs.active[t])) continue;
    const el = document.createElement('div');
    el.className = 'live';
    el.innerHTML = '<div class="p"></div><div class="t"></div>';
    $('.p', el).textContent = NAME[t] + '：' + (live.progress || '处理中');
    $('.t', el).textContent = live.text || '';
    if (!live.text) $('.t', el).remove();
    out.push(el);
    for (const a of live.approvals || []) {
      const card = document.createElement('div');
      card.className = 'approval';
      card.innerHTML = '<b></b><code></code><div class="acts"><button class="no">拒绝</button><button class="yes">允许</button></div>';
      $('b', card).textContent = a.kind === 'command' ? NAME[t] + ' 想运行命令' : NAME[t] + ' 想修改文件';
      $('code', card).textContent = a.command || a.reason || a.cwd || '（没有附带说明）';
      if (!a.command && !a.reason && !a.cwd) $('code', card).remove();
      $('.yes', card).onclick = () => approve(t, a.id, true);
      $('.no', card).onclick = () => approve(t, a.id, false);
      out.push(card);
    }
  }
  return out;
}

function renderLog(stick = true) {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const items = messages.slice(-300).map(messageEl);
  if (!items.length && !busyChat) items.push(Object.assign(document.createElement('div'), { className: 'empty', textContent: target() === 'chat' ? '和月下说句话吧。' : '告诉月下要做什么，她会交给 ' + NAME[target()] + '。' }));
  log.replaceChildren(...items, ...liveEls());
  if (stick || atBottom) log.scrollTop = log.scrollHeight;
}

function render(stick) {
  if (!state) return;
  renderHead();
  renderStatus();
  renderLog(stick);
  renderDrawer();
}

// ---------------------------------------------------------------- 会话列表
function when(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + clock(ts);
}

function renderDrawer() {
  $('#drawer').hidden = !drawerOpen;
  if (!drawerOpen) return;
  const t = target();
  $('#drawer-title').textContent = NAME[t] + ' 会话';
  const list = convs.list.filter((c) => c.target === t);
  $('#conv-list').replaceChildren(...list.map((c) => {
    const li = document.createElement('li');
    li.className = c.id === convs.active[t] ? 'on' : '';
    li.innerHTML = '<div class="info"><span class="title"></span><span class="sub"></span></div>';
    $('.title', li).textContent = c.title;
    const dir = c.cwd ? ' · ' + c.cwd.split(/[\\/]/).filter(Boolean).pop() : '';
    $('.sub', li).textContent = when(c.updated) + ' · ' + c.count + ' 条' + dir;
    if (state.tasks[t]?.running === c.id) $('.sub', li).append(Object.assign(document.createElement('span'), { className: 'running', textContent: ' · 进行中' }));
    const act = (label, title, fn, cls = '') => {
      const b = Object.assign(document.createElement('button'), { className: 'act ' + cls, textContent: label, title });
      b.onclick = (e) => { e.stopPropagation(); fn(b); };
      li.append(b);
    };
    act('✎', '改名', () => startRename(li, c));
    if (t === 'codex' && c.threadId) act('↗', '在 Codex 里打开', () => openInCodex(c.id));
    act('🗑', '删除（只删月下这里的记录）', (b) => removeConv(b, c), 'danger');
    li.onclick = () => switchConv(c.id);
    li.ondblclick = (e) => { e.stopPropagation(); startRename(li, c); };
    return li;
  }));
  if (!list.length) $('#conv-list').append(Object.assign(document.createElement('li'), { className: 'empty', textContent: '还没有会话' }));
}

function startRename(li, c) {
  const info = $('.info', li);
  const input = Object.assign(document.createElement('input'), { value: c.title, maxLength: 60 });
  info.replaceChildren(input);
  input.focus();
  input.select();
  input.onclick = (e) => e.stopPropagation();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== c.title) {
      const r = await api('/conversations/' + c.id, 'PUT', { title: input.value });
      if (!r.ok) toast(r.message);
    }
    await loadConvs();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
}

async function removeConv(button, c) {
  if (!button.classList.contains('confirm')) {
    button.classList.add('confirm');
    button.textContent = '确认删除';
    setTimeout(() => { button.classList.remove('confirm'); button.textContent = '🗑'; }, 3000);
    return;
  }
  const r = await api('/conversations/' + c.id, 'DELETE');
  if (!r.ok) return toast(r.message);
  toast(target() === 'chat' ? '已删除这个闲聊' : '已删除月下这里的记录（' + NAME[target()] + ' 里的对话还在）');
  await loadConvs(true);
}

async function switchConv(id) {
  await api('/conversations/' + id + '/activate', 'POST', {});
  drawerOpen = false;
  await loadConvs(true);
}

async function openInCodex(id) {
  const r = await api('/conversations/' + id + '/open', 'POST', {});
  toast(r.ok ? '已让 Codex 打开这个对话' : r.message);
}

async function loadConvs(withMessages = false) {
  const previous = convs.active[target()];
  convs = await api('/conversations');
  if (withMessages || previous !== convs.active[target()]) await loadMessages();
  else render(false);
}

// ---------------------------------------------------------------- 操作
async function replayVoice(m) {
  try {
    const r = await api('/synth', 'POST', { text: m.text, emotion: m.emotion });
    if (!r.ok) throw new Error(r.message);
    const audio = new Audio(r.url);
    audio.volume = state.settings.voice.volume;
    await audio.play();
  } catch (error) {
    toast('语音不可用：' + error.message);
  }
}

async function approve(t, id, accept) {
  const r = await api('/task/approve', 'POST', { target: t, id, accept });
  if (!r.ok) toast('这个请求已经结束了');
}

async function setTarget(t) {
  const next = await api('/settings', 'PUT', { chatTarget: t });
  if (next.settings) { state = next; await loadMessages(); }
  $('#input').focus();
}

async function pickFolder() {
  const t = target();
  let dir = null;
  if (bridge?.pickFolder) dir = await bridge.pickFolder(state.settings[t].workdir || '');
  else toast('请在桌宠的月下卡片里选择目录，或在控制台「联动」里填写');
  if (!dir) return;
  const conv = activeConv();
  if (conv && (conv.threadId || conv.sessionId)) return toast('这个会话已经在原目录里开始了，换目录请先新建会话');
  const next = await api('/settings', 'PUT', { [t]: { workdir: dir } });
  if (next.settings) { state = next; render(); toast('任务目录：' + dir); }
}

$('#compose').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  const t = target();
  if (t === 'chat') {
    if (busyChat) return;
    input.value = '';
    messages.push({ role: 'user', channel: 'chat', text, ts: Date.now() });
    busyChat = true;
    render(true);
    let failure = null;
    try {
      const r = await api('/chat', 'POST', { text });
      if (!r.ok) failure = r.message || '没有收到回复';
    } catch {
      failure = '连不上月下的服务，她可能已经退出了';
    } finally {
      busyChat = false;
      await loadMessages().catch(() => render(true));
    }
    // 发送失败时服务端不记录这句话：把原话放回输入框，提示停留久一点，免得以为她没理你
    if (failure) {
      if (!input.value.trim()) input.value = text;
      toast('没发出去：' + failure + '（原话已放回输入框）', 8000);
    }
    return;
  }
  if (state.tasks[t].live.working) return toast(NAME[t] + ' 还在处理上一件事，可以先点「停止」');
  input.value = '';
  const r = await api('/task', 'POST', { target: t, text });
  if (!r.ok) toast(r.message);
  await loadMessages();
});
$('#input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#compose').requestSubmit(); }
});
$('#input').addEventListener('input', () => {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(110, el.scrollHeight) + 'px';
});
for (const b of document.querySelectorAll('#targets button')) b.addEventListener('click', () => setTarget(b.dataset.target));
$('#folder').addEventListener('click', () => { if (!$('#folder').classList.contains('locked')) void pickFolder(); else toast('这个会话固定在原目录，换目录请新建会话'); });
$('#convs').addEventListener('click', () => { drawerOpen = !drawerOpen; render(false); });
$('#new-conv').addEventListener('click', async () => {
  await api('/conversations', 'POST', { target: target() });
  drawerOpen = false;
  await loadConvs(true);
  $('#input').focus();
});
$('#open-codex').addEventListener('click', () => { const c = activeConv(); if (c) void openInCodex(c.id); });
$('#stop').addEventListener('click', async () => { await api('/task/interrupt', 'POST', { target: target() }); });
$('#refresh').addEventListener('click', async () => { state.quota = await api('/quota?force=1'); render(false); toast('额度已刷新'); });
$('#console').addEventListener('click', () => (bridge ? bridge.openConsole('home') : window.open('/companion/console.html', '_blank')));
$('#close').addEventListener('click', () => (bridge ? bridge.close() : window.close()));

async function loadMessages() {
  if (!convs.active[target()]) convs = await api('/conversations');
  const id = convs.active[target()];
  const r = id ? await api('/conversations/' + id + '/messages') : { messages: [] };
  messages = r.ok === false ? [] : r.messages;
  render(true);
}

subscribe({
  state: (s) => { const first = !state; state = s; if (first) void loadConvs(true); else render(false); },
  conversations: () => void loadConvs(),
  task: (e) => {
    if (!state) return;
    state.tasks[e.target].live = e.live;
    state.tasks[e.target].running = e.kind === 'done' ? null : e.conversation || state.tasks[e.target].running;
    // 只把结果加进正在看的那个会话；其他会话的条数由会话列表刷新
    if ((e.kind === 'queued' || e.kind === 'done' || e.kind === 'step') && e.message && e.target === target() && e.conversation === convs.active[target()]) {
      if (!messages.some((m) => m.id === e.message.id)) messages.push(e.message);
    }
    if (e.kind === 'done' || e.kind === 'queued') void loadConvs();
    render(e.kind === 'done' || e.kind === 'queued'); // 新步骤到来时只在已经看到底部时才跟着滚动
  },
  chat: (e) => { if (target() === 'chat' && e.conversation === convs.active.chat) void loadMessages(); },
  quota: (q) => { if (state) { state.quota = { ...state.quota, ...q }; renderStatus(); } },
});

// 打开时读一次额度（5 分钟内有缓存就直接用）
api('/quota').then((q) => { if (state) { state.quota = q; renderStatus(); } }).catch(() => {});
setInterval(() => state && renderStatus(), 60000);
bridge?.onTab?.(() => $('#input').focus());
