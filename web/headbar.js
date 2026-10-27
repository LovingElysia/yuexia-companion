// 月下头顶状态栏：左边 Codex 剩余额度，中间当前状态（月下派的活优先，其次是你在 Codex / DSH 里的会话），右边 DeepSeek 余额。
// 点左右圆环打开状态卡并切到对应工具，点中间打开月下卡片。
import { api, subscribe } from './api.js';

const $ = (s) => document.querySelector(s);
const bridge = window.companionBridge;
const ARC = 2 * Math.PI * 16.6, OPEN = ARC * 0.75; // 270° 开口圆环
const NAME = { codex: 'Codex', dsh: 'DSH' };
const SESSION = { waiting: ['待操作', 'need', 4], working: ['执行中', 'busy', 3], responding: ['回复中', 'busy', 2], thinking: ['思考中', 'busy', 1] };
let state = null;

function dial(el, fraction, low) {
  el.querySelector('.track').style.strokeDasharray = `${OPEN} ${ARC}`;
  const value = el.querySelector('.value'), f = Math.max(0, Math.min(1, fraction));
  value.style.strokeDasharray = `${f * OPEN} ${ARC}`;
  value.style.opacity = f > 0 ? '1' : '0'; // 长度为 0 的圆头线段仍会画出一个点
  el.classList.toggle('low', !!low);
}

function until(ms) {
  const left = ms - Date.now();
  if (!ms || left <= 0) return '';
  const d = Math.floor(left / 86400000), h = Math.floor((left % 86400000) / 3600000), m = Math.floor((left % 3600000) / 60000);
  return (d ? `${d}天${h}时` : h ? `${h}时${m}分` : `${Math.max(1, m)}分钟`) + '后重置';
}

/** 与白龙相同：优先显示 5 小时额度；5 小时用完但每周还有时显示每周；已过重置时间的视为等待更新。 */
function codexWindow(windows) {
  const five = windows.find((w) => w.name === '5小时'), week = windows.find((w) => w.name === '一周');
  let chosen = five || week || windows[0] || null;
  if (five && five.remaining === 0 && week && !(five.resetsAt && five.resetsAt <= Date.now())) chosen = week;
  if (chosen && chosen.resetsAt && chosen.resetsAt <= Date.now()) return { ...chosen, pending: true };
  return chosen;
}

function renderCodex() {
  const q = state?.quota || {}, el = $('#codex');
  const windows = q.codex?.windows || [];
  const w = codexWindow(windows);
  const value = w && !w.pending && Number.isFinite(w.remaining) ? w.remaining : null;
  $('#codex b').textContent = value === null ? '—' : value > 0 && value < 1 ? '<1' : String(Math.min(value === 100 ? 100 : 99, Math.round(value)));
  $('#codex small').textContent = value === null ? '' : '%';
  dial(el, value === null ? 0 : value / 100, value !== null && value <= 15);
  const lines = windows.map((x) => `${x.name === '一周' ? '每周' : x.name}剩余 ${x.remaining}%${until(x.resetsAt) ? ' · ' + until(x.resetsAt) : ''}`);
  el.title = 'Codex 额度\n' + (lines.join('\n') || (q.error?.codex ? '读不到额度：' + q.error.codex : '读取中…')) + '\n点击查看详情';
}

function money(n) {
  return n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
}

function renderDsh() {
  const q = state?.quota || {}, ds = q.deepseek, el = $('#dsh');
  const cny = !ds || ds.currency === 'CNY';
  $('#dsh small').textContent = ds ? (cny ? '¥' : '$') : '';
  $('#dsh b').textContent = ds ? money(Number(ds.total) || 0) : '—';
  const low = !!ds && (!ds.available || ds.total < 1);
  dial(el, ds ? 1 : 0, low);
  el.title = 'DeepSeek 余额（DSH）\n' + (ds
    ? `${cny ? '¥' : '$'}${Number(ds.total).toFixed(2)}（充值 ${Number(ds.topped ?? 0).toFixed(2)} · 赠送 ${Number(ds.granted ?? 0).toFixed(2)}）${low ? '\n余额不多了，记得充值' : ''}`
    : q.error?.deepseek ? '读取失败：' + q.error.deepseek : q.checked ? '在控制台保存 DeepSeek 密钥后显示' : '读取中…') + '\n点击查看详情';
}

/** 月下派的活优先（等批准 > 处理中），其次是你自己在 Codex / DSH 里正在进行的会话，最后是刚完成的会话。 */
function status() {
  const order = state.settings.link === 'dsh' ? ['dsh', 'codex'] : ['codex', 'dsh'];
  for (const t of order) if (state.tasks[t].live.approvals?.length) return { text: '待批准', tone: 'need', who: t, tip: '月下派给 ' + NAME[t] + ' 的活在等你批准' };
  for (const t of order) {
    const live = state.tasks[t].live;
    if (live.working) return { text: '执行中', tone: 'busy', who: t, tip: '月下派的活：' + (live.progress || '处理中') };
  }
  let best = null;
  for (const t of order) {
    for (const s of state[t].sessions || []) {
      const info = s.active && SESSION[s.state];
      if (info && (!best || info[2] > best.rank)) best = { text: info[0], tone: info[1], rank: info[2], who: t, tip: `${s.title || NAME[t]}：${s.label || info[0]}` };
    }
  }
  if (best) return best;
  for (const t of order) {
    const last = state[t].sessions?.[0];
    if (last?.state === 'complete' && Date.now() - last.updated < 10 * 60 * 1000) return { text: '已完成', tone: 'done', who: t, tip: `${last.title || NAME[t]}：已完成` };
  }
  return { text: '待命', tone: '', who: null, tip: 'Codex 与 DSH 都没有进行中的任务' };
}

function renderStatus() {
  const s = status(), pill = $('#pill');
  $('#status').textContent = s.who ? `${s.text} · ${NAME[s.who]}` : s.text;
  pill.className = 'pill' + (s.tone ? ' ' + s.tone : '');
  pill.title = s.tip + '\n点击和月下聊天 / 派活';
}

function render() {
  if (!state) return;
  renderCodex();
  renderDsh();
  renderStatus();
}

function openStatus(source) {
  try { localStorage.setItem('yuexia.status.source', source); } catch {}
  if (bridge?.openStatus) bridge.openStatus(source);
  else window.open('/companion/status.html', 'yuexia-status', 'width=330,height=250');
}
$('#codex').onclick = () => openStatus('codex');
$('#dsh').onclick = () => openStatus('dsh');
$('#pill').onclick = () => (bridge ? bridge.openCard() : window.open('/companion/card.html', 'yuexia-card', 'width=380,height=600'));

subscribe({
  state: (s) => { state = s; render(); },
  quota: (q) => { if (state) { state.quota = { ...state.quota, ...q }; renderCodex(); renderDsh(); } },
  task: (e) => { if (state) { state.tasks[e.target].live = e.live; renderStatus(); } },
});
api('/quota').then((q) => { if (state) { state.quota = q; render(); } }).catch(() => {});
// 重置时间与「刚完成」会随时间变化；额度本身由服务端每 5 分钟最多刷新一次
setInterval(render, 30000);
setInterval(() => api('/quota').then((q) => { if (state) { state.quota = q; render(); } }).catch(() => {}), 5 * 60 * 1000 + 5000);
