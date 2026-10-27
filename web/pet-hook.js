// 由陪伴服务追加到月下动作包的 preview.html 末尾：只把播放器的阶段（idle / 各动作）报告给服务，
// 让语音只在待机时出声、气泡在表演时让位。动作包自身的页面逻辑不受影响。
import { api, subscribe } from './api.js';

const desktop = new URLSearchParams(location.search).has('desktop');
let last = null;

function report(phase) {
  if (!phase || phase === last) return;
  last = phase;
  api('/pet/phase', 'POST', { phase }).catch(() => {});
}

async function attach() {
  for (let i = 0; i < 600 && !window.pet; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const pet = window.pet;
  if (!pet) return;
  pet.addEventListener('phase', (event) => report(String(event.detail)));
  if (pet.phase) report(pet.phase);
  applyAuto();
}

// 「自动播放动作」跟随陪伴版设置（默认开）：动作包自己的开关只记在本窗口，这里用设置覆盖它；
// 你在页面上亲手点的开关写回设置，右键菜单和控制台改的也会同步过来。
// 动作包在 window.pet 出现的同一段同步代码里接好开关的 onchange，所以等 window.pet 出现后再改。
const automatic = document.querySelector('#automatic');
let autoWanted = null;
function applyAuto() {
  if (!automatic || autoWanted === null || !window.pet || automatic.checked === autoWanted) return;
  automatic.checked = autoWanted;
  automatic.dispatchEvent(new Event('change')); // 让动作包按它自己的方式开始或停止计时
}
if (automatic) {
  automatic.addEventListener('change', (e) => {
    if (e.isTrusted) api('/settings', 'PUT', { autoPlay: automatic.checked }).catch(() => {});
  });
  subscribe({ state: (s) => { autoWanted = s.settings.autoPlay !== false; applyAuto(); } });
}

void attach();

// 网页预览里（不是桌面窗口）在标题栏旁放一个控制台入口
if (!desktop) {
  const link = document.createElement('a');
  link.href = '/companion/console.html';
  link.target = '_blank';
  link.textContent = '月下控制台';
  link.style.cssText = 'position:fixed;right:18px;top:14px;z-index:9;padding:7px 14px;border-radius:8px;border:1px solid #bb7e83;background:#864454;color:#f9edf0;font:14px "Microsoft YaHei",system-ui;text-decoration:none';
  document.body.append(link);
}

// 桌面窗口里单击待机的月下：弹出 / 收起状态卡。双击仍是原包的摩天轮，拖动不算单击。
if (desktop && window.yuexiaCompanion) {
  const stage = document.querySelector('#stage');
  let down = null, timer = null;
  stage.addEventListener('pointerdown', (e) => { if (e.button === 0) down = { x: e.screenX, y: e.screenY }; });
  stage.addEventListener('pointerup', (e) => {
    const start = down;
    down = null;
    if (!start || e.button !== 0 || Math.hypot(e.screenX - start.x, e.screenY - start.y) > 4) return;
    if (!window.pet || window.pet.phase !== 'idle' || !window.pet.hit(e.clientX, e.clientY)) return;
    clearTimeout(timer);
    timer = setTimeout(() => window.yuexiaCompanion.toggleStatus(), 280);
  });
  stage.addEventListener('dblclick', () => clearTimeout(timer));
}
