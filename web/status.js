// 月下状态卡：单击桌宠弹出的微型面板。顶部滑块选 Codex 或 DSH：
//   Codex：5 小时 / 每周剩余额度 + Codex 的 Token 用量
//   DSH：DeepSeek 账户余额 + DSH 的 Token 用量
// 聊天在月下卡片里（点聊天按钮打开）。
import { api, subscribe } from './api.js';

const $ = (s, root = document) => root.querySelector(s);
const bridge = window.companionBridge;
if (!bridge) document.body.classList.add('browser');

const STATE = { thinking: '正在思考', working: '正在工作', responding: '正在整理回复', waiting: '等你批准', complete: '已完成', interrupted: '已中断', idle: '空闲' };
const STORE = 'yuexia.status.source';
let state = null, usage = {}, range = 'week', hours = false, picked = null;

try { picked = localStorage.getItem(STORE); } catch {}
// 没选过时跟随当前联动
const source = () => (picked === 'codex' || picked === 'dsh' ? picked : state?.settings.link === 'dsh' ? 'dsh' : 'codex');

function fmt(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const money = (value, currency) => (currency === 'CNY' ? '¥' : (currency || '') + ' ') + Number(value || 0).toFixed(2);

function until(ms) {
  if (!ms) return '';
  const left = ms - Date.now();
  if (left <= 0) return '即将重置';
  const d = Math.floor(left / 86400000), h = Math.floor((left % 86400000) / 3600000), m = Math.floor((left % 3600000) / 60000);
  return (d ? `${d}天${h}时` : h ? `${h}时${m}分` : `${Math.max(1, m)}分钟`) + '后重置';
}

function renderHead() {
  const src = source();
  $('#slider').classList.toggle('dsh', src === 'dsh');
  const sessions = state[src].sessions || [];
  const live = state.tasks[src].live;
  $('#count').textContent = String(sessions.filter((s) => s.active).length + (live.working ? 1 : 0) || sessions.length);
  const rows = [];
  if (live.approvals?.length) rows.push({ title: '月下派的活', label: '等你批准', need: true });
  else if (live.working) rows.push({ title: '月下派的活', label: live.progress || '处理中' });
  for (const s of sessions.filter((x) => x.active)) rows.push({ title: s.title, label: s.label });
  if (!rows.length && sessions[0]) rows.push({ title: sessions[0].title, label: STATE[sessions[0].state] || '' });
  if (!rows.length) rows.push({ title: src === 'codex' ? 'Codex' : 'DSH', label: state[src].status === 'missing' ? '没有找到本机记录' : '最近 12 小时没有会话' });
  $('#lines').replaceChildren(...rows.slice(0, 2).map((r) => {
    const row = document.createElement('div');
    row.className = 'row' + (r.need ? ' need' : '');
    row.innerHTML = '<b></b><span></span>';
    $('b', row).textContent = r.title;
    $('span', row).textContent = r.label;
    return row;
  }));
}

function renderLeft() {
  const src = source(), q = state.quota || {};
  $('#codex-quota').hidden = src !== 'codex';
  $('#dsh-money').hidden = src !== 'dsh';
  if (src === 'codex') {
    const windows = q.codex?.windows || [];
    for (const [id, name] of [['#q5', '5小时'], ['#qw', '一周']]) {
      const w = windows.find((x) => x.name === name), el = $(id);
      $('b', el).textContent = w ? w.remaining + '%' : '—';
      $('u', el).style.width = (w ? w.remaining : 0) + '%';
      $('small', el).textContent = w ? until(w.resetsAt) : q.error?.codex ? '读不到额度' : '读取中…';
      el.classList.toggle('low', !!w && w.remaining <= 10);
    }
  } else {
    const ds = q.deepseek;
    $('#balance').textContent = ds ? money(ds.total, ds.currency) : '—';
    $('#balance').classList.toggle('low', !!ds && (!ds.available || ds.total < 1));
    $('#topped').textContent = ds && ds.topped !== undefined ? money(ds.topped, ds.currency) : '—';
    $('#granted').textContent = ds && ds.granted !== undefined ? money(ds.granted, ds.currency) : '—';
    $('#balance-note').textContent = ds ? (ds.available ? (ds.total < 1 ? '余额不多了，记得充值' : '账户可用') : '余额不足，DSH 与闲聊会失败')
      : q.error?.deepseek ? '读取失败：' + q.error.deepseek : q.checked ? '在控制台保存 DeepSeek 密钥后显示' : '读取中…';
  }
}

function renderTokens() {
  const u = usage[source()];
  for (const b of document.querySelectorAll('#ranges button')) b.classList.toggle('on', !hours && b.dataset.range === range);
  $('#hours').classList.toggle('on', hours);
  if (!u) { $('#sum').textContent = '统计中…'; $('#today').textContent = '—'; $('#bars').replaceChildren(); return; }
  $('#today').textContent = fmt(u.today) + (u.scanning ? ' · 统计中' : '');
  const list = hours ? u.last24 : u[range];
  const total = hours ? list.reduce((n, x) => n + x.tokens, 0) : range === 'all' ? u.total : range === 'month' ? u.monthTotal : u.weekTotal;
  $('#sum').textContent = (hours ? '24小时' : { all: '全部', month: '30天', week: '7天' }[range]) + ' · ' + fmt(total);
  const max = Math.max(1, ...list.map((x) => x.tokens));
  $('#bars').replaceChildren(...list.map((x, i) => {
    const bar = document.createElement('i');
    bar.style.height = Math.max(x.tokens ? 3 : 1, Math.round((x.tokens / max) * 52)) + 'px';
    if (i === list.length - 1) bar.className = 'today';
    bar.title = (hours ? x.hour + '时' : x.day) + '：' + fmt(x.tokens);
    return bar;
  }));
  const label = (x) => (hours ? x.hour + '时' : x.day.slice(5).replace('-', '/'));
  $('#from').textContent = list.length ? label(list[0]) : '';
  $('#to').textContent = list.length ? label(list[list.length - 1]) : '';
}

function render() {
  if (!state) return;
  renderHead();
  renderLeft();
  renderTokens();
}

async function loadUsage() {
  const [codex, dsh] = await Promise.all([api('/usage?source=codex'), api('/usage?source=dsh')]);
  usage = { codex, dsh };
  render();
}

for (const b of document.querySelectorAll('#slider button')) {
  b.onclick = () => {
    picked = b.dataset.source;
    try { localStorage.setItem(STORE, picked); } catch {}
    render();
  };
}
for (const b of document.querySelectorAll('#ranges button')) b.onclick = () => { range = b.dataset.range; hours = false; renderTokens(); };
$('#hours').onclick = () => { hours = !hours; renderTokens(); };
$('#refresh').onclick = async () => {
  state.quota = await api('/quota?force=1');
  await loadUsage();
};
$('#chat').onclick = () => (bridge ? bridge.openCard() : window.open('/companion/card.html', 'yuexia-card', 'width=380,height=600'));
$('#console').onclick = () => (bridge ? bridge.openConsole('home') : window.open('/companion/console.html', '_blank'));
// 鼠标停留时不自动收起
document.addEventListener('mouseenter', () => bridge?.statusHover?.(true));
document.addEventListener('mouseleave', () => bridge?.statusHover?.(false));

subscribe({
  state: (s) => { const first = !state; state = s; if (first) void loadUsage(); render(); },
  quota: (q) => { if (state) { state.quota = { ...state.quota, ...q }; renderLeft(); } },
  usage: (u) => { usage = { codex: u.codex, dsh: u.dsh }; render(); },
  task: (e) => { if (state) { state.tasks[e.target].live = e.live; renderHead(); } },
});

api('/quota').then((q) => { if (state) { state.quota = q; renderLeft(); } }).catch(() => {});
bridge?.onTab?.(() => {
  // 从头顶状态栏点开时，那边已经把要看的工具写进了 localStorage
  try { picked = localStorage.getItem(STORE); } catch {}
  render();
  void loadUsage();
  api('/quota').then((q) => { if (state) { state.quota = q; renderLeft(); } });
});
setInterval(() => state && renderLeft(), 60000);
