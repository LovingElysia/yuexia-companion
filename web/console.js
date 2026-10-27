// 月下控制台：所有数据来自陪伴服务的 /api/state 与 /api/events，设置改动即时保存。
import { api, subscribe } from './api.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const bridge = window.companionBridge;

const EMOTIONS = {
  neutral: ['平静', '今天也辛苦了，我一直在这里。'],
  relaxed: ['放松', '嗯……就这样靠着你，好安心。'],
  shy: ['害羞', '你、你一直看着我做什么……没什么啦。'],
  sad: ['低落', '你要是不理我，我会寂寞的哦。'],
  happy: ['开心', '太好了！今晚一起去看月亮吧。'],
  surprised: ['惊讶', '咦？真的吗？我还以为是做梦。'],
  curious: ['好奇', '这是什么？给我看看嘛。'],
  angry: ['生气', '哼，人类，不许笑我！'],
};
const SOURCE = { chat: '对话', work: '提醒', test: '试听' };
const LINK_NAME = { none: '独立陪伴', codex: 'Codex', dsh: 'DeepSeek Harness' };
const VOICE_NAME = { unknown: '检测中', offline: '未运行', starting: '载入中', ready: '就绪', error: '出错' };
const CODEX_STATE = { idle: '空闲', thinking: '思考中', working: '工作中', responding: '整理回复', waiting: '等你批准', complete: '已完成', interrupted: '已中断' };

let state = null;
let pinned = false;
const timeline = [];

// ---------------------------------------------------------------- 小工具
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('on'), 2600);
}

function get(obj, dotted) {
  return dotted.split('.').reduce((value, key) => (value == null ? value : value[key]), obj);
}

function patchOf(dotted, value) {
  const keys = dotted.split('.');
  const patch = {};
  let cursor = patch;
  keys.slice(0, -1).forEach((key) => { cursor = cursor[key] = {}; });
  cursor[keys[keys.length - 1]] = value;
  return patch;
}

async function save(patch, message) {
  try {
    const next = await api('/settings', 'PUT', patch);
    if (!next.settings) throw new Error(next.message || '服务没有返回设置');
    state = next;
    render();
    if (message) toast(message);
  } catch (error) {
    render();
    toast('保存失败：' + error.message);
  }
}

function badge(el, text, tone) {
  el.textContent = text;
  el.className = 'badge' + (tone ? ' ' + tone : '');
}

const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------- 选项卡
function showTab(tab) {
  const name = $$('[data-panel]').some((p) => p.dataset.panel === tab) ? tab : 'home';
  $$('[data-panel]').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
}
$$('.nav button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$$('[data-go]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
bridge?.onTab((tab) => showTab(tab));

// 窗口按钮（浏览器里打开时隐藏）
if (bridge) {
  $('#minimize').onclick = () => bridge.minimize();
  $('#maximize').onclick = () => bridge.maximize();
  $('#close').onclick = () => bridge.close();
  $('#pin').onclick = () => { pinned = !pinned; bridge.pin(pinned); $('#pin').classList.toggle('on', pinned); };
} else {
  $('.win-buttons').style.display = 'none';
}

// ---------------------------------------------------------------- 渲染
function render() {
  if (!state) return;
  const s = state.settings;
  renderPresence();
  renderHome();
  renderLink();
  renderVoice();
  renderPersona();
  // 通用开关与滑块
  $$('[data-setting]').forEach((input) => {
    const value = get(s, input.dataset.setting);
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value;
  });
  $('#speed-out').textContent = s.voice.speed.toFixed(2) + '×';
  $('#volume-out').textContent = Math.round(s.voice.volume * 100) + '%';
  // 关于
  $('#version').textContent = 'v' + state.version;
  $('#base-name').textContent = state.base.ok ? state.base.name : '找不到动作包';
  $('#base-path').textContent = state.base.path;
  $('#about-data').textContent = state.dataDir;
  $('#data-dir').textContent = state.dataDir;
  if (document.activeElement !== $('#base-input')) $('#base-input').value = s.basePackage;
}

function voiceTone() {
  const v = state.voice;
  if (!state.settings.voice.enabled) return ['已关闭', ''];
  if (v.state === 'ready') return [v.detail ? '音色缺失' : '就绪', v.detail ? 'warn' : 'ok'];
  if (v.state === 'starting') return ['载入中', 'warn'];
  if (v.state === 'error') return ['出错', 'bad'];
  return [VOICE_NAME[v.state] || v.state, ''];
}

function linkStatus() {
  const link = state.settings.link;
  if (link === 'codex' || link === 'dsh') {
    const c = state[link];
    if (c.status === 'missing') return [link === 'codex' ? '未找到 Codex 数据' : '未找到 DSH 数据', 'bad', c.home];
    const active = c.sessions.find((x) => x.active);
    return [active ? CODEX_STATE[active.state] : '已连接', active ? 'warn' : 'ok', active ? active.title : `${c.sessions.length} 个最近会话`];
  }
  return ['独立陪伴', '', '不读取工作状态'];
}

function renderPresence() {
  const busy = (state.settings.link === 'codex' && state.codex.active > 0) || (state.settings.link === 'dsh' && state.dsh.active > 0) || state.chat.busy;
  const phase = state.pet.phase;
  $('#presence-dot').className = busy ? 'busy' : phase === 'unknown' ? '' : 'ok';
  $('#presence').textContent = busy ? '正在陪你工作' : phase === 'unknown' ? '桌宠未打开' : phase === 'idle' ? '在桌面上等你' : '正在表演';
  const [linkText, linkTone] = linkStatus();
  const chip = $('#link-chip');
  chip.textContent = LINK_NAME[state.settings.link] + (state.settings.link === 'none' ? '' : ' · ' + linkText);
  chip.className = 'chip ' + linkTone;
  const [voiceText, tone] = voiceTone();
  const vchip = $('#voice-chip');
  vchip.textContent = '语音 · ' + voiceText;
  vchip.className = 'chip ' + tone;
}

function renderHome() {
  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 5 ? '夜深了，人类' : hour < 11 ? '早上好，人类' : hour < 14 ? '中午好，人类' : hour < 18 ? '下午好，人类' : '晚上好，人类';
  const [linkText, linkTone, linkNote] = linkStatus();
  $('#home-link').textContent = LINK_NAME[state.settings.link] + (state.settings.link === 'none' ? '' : ' · ' + linkText);
  $('#home-link').style.color = linkTone === 'bad' ? 'var(--bad)' : '';
  $('#home-link-note').textContent = linkNote || '';
  const [voiceText] = voiceTone();
  $('#home-voice').textContent = voiceText;
  $('#home-voice-note').textContent = state.voice.detail || (state.voice.pending ? `正在合成 ${state.voice.pending} 句` : state.settings.voice.profile);
  $('#home-chat').textContent = state.chat.ready ? '可以聊天' : '未就绪';
  $('#home-chat-note').textContent = state.chat.detail;
}

function renderSessions(list, watcher, enabled, emptyText) {
  list.replaceChildren(...(watcher.sessions.length ? watcher.sessions.map((x) => {
    const li = document.createElement('li');
    li.innerHTML = '<i class="state-dot"></i><span class="title"></span><span class="label"></span>';
    li.firstChild.classList.add(x.state);
    $('.title', li).textContent = x.title;
    $('.label', li).textContent = x.active ? x.label : CODEX_STATE[x.state] || x.state;
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: enabled ? '最近 12 小时没有会话。' : emptyText })]));
}

function renderLink() {
  const s = state.settings;
  for (const [id, value] of [['#codex-workdir', s.codex.workdir], ['#dsh-workdir', s.dsh.workdir], ['#dsh-app', s.dsh.app]]) if (document.activeElement !== $(id)) $(id).value = value;
  $('#codex-sandbox').value = s.codex.sandbox;
  $('#codex-exe').textContent = state.tasks?.codex.exe || '首次派活时自动查找（Codex 桌面版自带的 codex.exe）';
  $$('input[name=link]').forEach((r) => { r.checked = r.value === s.link; });
  $$('[data-show-link]').forEach((el) => el.classList.toggle('show', el.dataset.showLink === s.link || (el.dataset.showLink === 'work' && s.link !== 'none')));
  for (const id of ['codex', 'dsh']) {
    const watcher = state[id], enabled = s.link === id;
    if (document.activeElement !== $('#' + id + '-home')) $('#' + id + '-home').value = s[id].home;
    $('#' + id + '-home-hint').textContent = '当前读取：' + watcher.home;
    badge($('#' + id + '-badge'), !enabled ? '未启用' : watcher.status === 'missing' ? '未找到数据' : watcher.status === 'watching' ? '正在跟随' : '启动中', !enabled ? '' : watcher.status === 'missing' ? 'bad' : 'ok');
    renderSessions($('#' + id + '-sessions'), watcher, enabled, '选择这种接入方式后，会在这里显示最近的会话。');
  }
}

function renderVoice() {
  const v = state.voice;
  const [text, tone] = voiceTone();
  badge($('#voice-badge'), text, tone);
  $('#voice-detail').textContent = [v.detail, v.pending ? `排队中 ${v.pending} 句` : '', v.managed ? '由月下启动' : v.state === 'ready' ? '使用已在运行的服务' : ''].filter(Boolean).join(' · ');
  $('#voice-start').disabled = v.state === 'ready' || v.state === 'starting';
  $('#voice-stop').disabled = !v.managed;
  const select = $('#voice-profile');
  const options = [...new Set([state.settings.voice.profile, ...v.voices.filter((id) => id.startsWith('yuexia'))])];
  if (select.options.length !== options.length || [...select.options].some((o, i) => o.value !== options[i])) {
    select.replaceChildren(...options.map((id) => new Option(id, id)));
  }
  select.value = state.settings.voice.profile;
  $('#voice-device').value = state.settings.voice.device;
  const device = v.device;
  $('#device-reason').textContent = device ? (device.device === 'cuda' ? '正在用显卡：' : '正在用 CPU：') + device.reason : v.managed || v.state !== 'ready' ? '启动语音服务时检测' : '语音服务由其他程序启动，设备以它为准';
  $('#device-reason').style.color = device?.needsCudaTorch ? 'var(--warn)' : '';
  if (document.activeElement !== $('#voice-url')) $('#voice-url').value = state.settings.voice.url;
  if (document.activeElement !== $('#voice-root')) $('#voice-root').value = state.settings.voice.root;
}

function renderPersona() {
  const chat = state.settings.chat;
  $$('input[name=provider]').forEach((r) => { r.checked = r.value === chat.provider; });
  $$('[data-show-provider]').forEach((el) => el.classList.toggle('show', el.dataset.showProvider === chat.provider));
  badge($('#chat-badge'), state.chat.ready ? '就绪' : '未就绪', state.chat.ready ? 'ok' : chat.provider === 'off' ? '' : 'warn');
  for (const [id, key] of [['#chat-base', 'baseUrl'], ['#chat-model', 'model'], ['#chat-rounds', 'memoryRounds']]) {
    if (document.activeElement !== $(id)) $(id).value = chat[key];
  }
  $('#key-hint').textContent = chat.hasApiKey ? '已保存：' + chat.apiKeyHint : '尚未保存密钥';
  if (document.activeElement !== $('#persona') && !$('#persona').dataset.dirty) $('#persona').value = chat.persona || state.defaultPersona;
}

// ---------------------------------------------------------------- 时间线
function addTimeline(event) {
  timeline.unshift(event);
  timeline.length = Math.min(timeline.length, 40);
  $('#last-line').textContent = '「' + event.text + '」';
  const list = $('#timeline');
  list.replaceChildren(...timeline.map((e) => {
    const li = document.createElement('li');
    li.innerHTML = '<time></time><span class="src"></span><span><span class="line"></span> <span class="caption"></span></span>';
    $('time', li).textContent = clock(e.ts);
    $('.src', li).textContent = SOURCE[e.source] || e.source;
    $('.line', li).textContent = e.text;
    $('.caption', li).textContent = e.caption ? '「' + e.caption + '」' : '';
    return li;
  }));
}

// ---------------------------------------------------------------- 对话入口
// 对话与派活在精简的「月下卡片」里进行；控制台只放设置
function openCard() {
  if (bridge?.openCard) bridge.openCard();
  else window.open('/companion/card.html', 'yuexia-card', 'width=380,height=600');
}
$$('[data-card]').forEach((b) => b.addEventListener('click', openCard));

// ---------------------------------------------------------------- 设置控件
$$('[data-setting]').forEach((input) => {
  input.addEventListener(input.type === 'range' ? 'change' : 'input', () => {
    if (input.type !== 'checkbox' && input.type !== 'range') return;
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    void save(patchOf(input.dataset.setting, value));
  });
  if (input.type === 'range') {
    input.addEventListener('input', () => {
      if (input.dataset.setting === 'voice.speed') $('#speed-out').textContent = Number(input.value).toFixed(2) + '×';
      if (input.dataset.setting === 'voice.volume') $('#volume-out').textContent = Math.round(input.value * 100) + '%';
    });
  }
});
$$('input[name=link]').forEach((r) => r.addEventListener('change', () => save({ link: r.value }, '已切换为' + LINK_NAME[r.value])));
$$('input[name=provider]').forEach((r) => r.addEventListener('change', () => save({ chat: { provider: r.value } })));

function onCommit(selector, patch, message) {
  const el = $(selector);
  el.addEventListener('change', () => save(patch(el.value), message));
}
onCommit('#codex-home', (v) => ({ codex: { home: v } }), '已更新 Codex 数据目录');
onCommit('#codex-workdir', (v) => ({ codex: { workdir: v } }), '已更新 Codex 任务目录');
onCommit('#codex-sandbox', (v) => ({ codex: { sandbox: v } }), '已更新 Codex 权限（新对话生效）');
onCommit('#dsh-workdir', (v) => ({ dsh: { workdir: v } }), '已更新 DSH 任务目录');
onCommit('#dsh-app', (v) => ({ dsh: { app: v } }), '已更新 DSH 程序路径');
onCommit('#dsh-home', (v) => ({ dsh: { home: v } }), '已更新 DSH 数据目录');
onCommit('#chat-base', (v) => ({ chat: { baseUrl: v } }), '已更新接口地址');
onCommit('#chat-model', (v) => ({ chat: { model: v } }), '已更新模型');
onCommit('#chat-rounds', (v) => ({ chat: { memoryRounds: Number(v) } }));
onCommit('#voice-url', (v) => ({ voice: { url: v } }), '已更新语音服务地址');
onCommit('#voice-root', (v) => ({ voice: { root: v } }), '已更新安装目录');
onCommit('#voice-profile', (v) => ({ voice: { profile: v } }), '已切换音色档案');
onCommit('#voice-device', (v) => ({ voice: { device: v } }), '已更新合成设备，月下启动的语音服务会按新设置重启');
onCommit('#base-input', (v) => ({ basePackage: v }), '重新启动桌宠后使用新的动作包');

$('#save-key').addEventListener('click', async () => {
  const key = $('#chat-key').value.trim();
  if (!key) return toast('请先填入密钥');
  await save({ chat: { apiKey: key } }, '密钥已保存');
  $('#chat-key').value = '';
});
$('#clear-key').addEventListener('click', () => save({ chat: { clearApiKey: true } }, '密钥已清除'));
$('#load-models').addEventListener('click', async () => {
  const result = await api('/chat/models');
  if (!result.ok) return toast(result.message);
  $('#model-list').replaceChildren(...result.models.map((id) => new Option(id, id)));
  toast(`取到 ${result.models.length} 个模型，点模型输入框选择`);
});
$('#persona').addEventListener('input', () => { $('#persona').dataset.dirty = '1'; });
$('#save-persona').addEventListener('click', async () => {
  const value = $('#persona').value.trim();
  await save({ chat: { persona: value === state.defaultPersona.trim() ? '' : value } }, '人设已保存');
  delete $('#persona').dataset.dirty;
});
$('#reset-persona').addEventListener('click', () => {
  $('#persona').value = state.defaultPersona;
  $('#persona').dataset.dirty = '1';
  toast('已填入默认人设，点“保存人设”生效');
});


$('#voice-start').addEventListener('click', async () => { await api('/voice/start', 'POST', {}); toast('正在启动语音服务，首次载入约 1—2 分钟'); });
$('#voice-refresh').addEventListener('click', async () => { state.voice = (await api('/voice/refresh', 'POST', {})).voice; render(); });
$('#voice-stop').addEventListener('click', async () => { await api('/voice/stop', 'POST', {}); toast('语音服务已停止'); });

// 试听语气
$('#emotions').replaceChildren(...Object.entries(EMOTIONS).map(([id, [name, line]]) => {
  const b = document.createElement('button');
  b.className = 'emotion';
  b.innerHTML = '<b></b><span></span>';
  $('b', b).textContent = name;
  $('span', b).textContent = line;
  b.onclick = async () => {
    const result = await api('/say', 'POST', { text: line, emotion: id });
    toast(result.ok ? '月下要开口了（第一次合成需要等一会儿）' : '没能说出来');
  };
  return b;
}));
$('#say-emotion').replaceChildren(...Object.entries(EMOTIONS).map(([id, [name]]) => new Option(name, id)));
$('#say-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('#say-text').value.trim();
  if (!text) return;
  const result = await api('/say', 'POST', { text, emotion: $('#say-emotion').value });
  toast(result.ok ? '已交给月下' : '没能说出来');
});
$('#say-greeting').addEventListener('click', async () => {
  const hour = new Date().getHours();
  const line = hour >= 18 || hour < 5 ? ['晚上好，人类。今晚的月亮很好看哦。', 'happy'] : hour < 11 ? ['早上好，人类。今天也让我陪着你吧。', 'relaxed'] : ['你回来啦。我一直在等你哦。', 'happy'];
  await api('/say', 'POST', { text: line[0], emotion: line[1] });
});

// ---------------------------------------------------------------- 实时事件
subscribe({
  state: (next) => { state = next; render(); },
  voice: (voice) => { if (state) { state.voice = voice; render(); } },
  say: addTimeline,
  work: () => {},
  phase: ({ phase }) => { if (state) { state.pet.phase = phase; renderPresence(); } },
});

showTab(decodeURIComponent(location.hash.slice(1)) || 'home');
state = await api('/state');
render();
