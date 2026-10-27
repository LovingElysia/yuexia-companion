'use strict';
// 月下陪伴版的 Electron 主进程。桌宠窗口的行为（拖动、礼物、穿透、动作切换时扩窗）沿用月下动作包的
// desktop.cjs，只是改成从陪伴服务加载页面、扩窗尺寸改为读取动作包 manifest.layout；
// 在此之上增加：头顶对话气泡、精简的月下卡片（对话 / 派活 / 额度）、月下控制台（设置），以及右键菜单里的入口。
const { app, BrowserWindow, Menu, ipcMain, screen, shell, dialog } = require('electron');
const path = require('node:path');
const { ensureServer, ORIGIN } = require('./lib/ensure-server.cjs');

app.setName('YuexiaCompanion');
app.setPath('userData', path.join(app.getPath('temp'), 'yuexia-companion'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();

// 待机时月下头顶在 384×320 窗口里的位置（idle 帧 draw=[360,180,720,720]、内容上沿 y≈46，按 1080 画布缩放）
const HEAD_ANCHOR = { x: 255, y: 92 };
const BUBBLE_SIZE = { width: 300, height: 170 };
const HEADBAR_SIZE = { width: 236, height: 48 };

let win, gifts, ghost, bubble, consoleWin, cardWin, statusWin, headbar;
let manifest = null, basePath = '', viewports = [];
let drag = null, gifting = false, pass = false, giftTimer, automatic = false, offset = [0, 0];
let companion = null; // 最近一次 /api/state
let bubbleWanted = false, bubbleIdle = true, headbarOn = true;

const send = (event, ...args) => win?.webContents.send(event, ...args);

const logFile = path.join(process.env.YUEXIA_COMPANION_HOME || path.join(process.env.LOCALAPPDATA || app.getPath('temp'), 'YuexiaCompanion'), 'desktop.log');
function log(message) {
  try { require('node:fs').appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch {}
}

async function api(route, method = 'GET', body) {
  const response = await fetch(ORIGIN + '/api' + route, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-yuexia-companion': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

/** 由 manifest.layout 推出允许的扩窗档位：画布尺寸 → 窗口尺寸与窗口内偏移（像素）。 */
function layoutViewports(layout) {
  const list = [];
  if (!layout) return [{ canvas: [1080, 900], size: [384, 320], offset: [0, 0] }];
  list.push({ canvas: layout.canvas || [1080, 900], size: layout.desktopSize || [384, 320], offset: [0, 0] });
  for (const key of Object.keys(layout)) {
    const match = key.match(/^(.+)Canvas$/);
    if (!match) continue;
    const canvas = layout[key], size = layout[match[1] + 'DesktopSize'], shift = layout[match[1] + 'Offset'] || [0, 0];
    if (!Array.isArray(canvas) || !Array.isArray(size)) continue;
    list.push({ canvas, size, offset: [Math.round(shift[0] * size[0] / canvas[0]), Math.round(shift[1] * size[1] / canvas[1])] });
  }
  return list;
}

function petPreferences() {
  return {
    preload: path.join(__dirname, 'preload-pet.cjs'),
    additionalArguments: ['--yuexia-base-preload=' + path.join(basePath, 'preload.cjs')],
    contextIsolation: true, nodeIntegration: false, sandbox: false,
  };
}

function uiPreferences() {
  return { preload: path.join(__dirname, 'preload-ui.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true };
}

function lockDown(target) {
  target.webContents.on('will-navigate', (e) => e.preventDefault());
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------- 礼物（与原包一致）
function giftMode(active) {
  gifting = !!active;
  clearTimeout(giftTimer);
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(gifting ? false : pass, { forward: true });
  if (!gifting && ghost && !ghost.isDestroyed()) { ghost.destroy(); ghost = null; }
  if (gifting) giftTimer = setTimeout(() => giftMode(false), 30000);
  send('pet:gift-mode', gifting);
}

function openGifts() {
  if (gifts && !gifts.isDestroyed()) { gifts.show(); gifts.focus(); return; }
  const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
  gifts = new BrowserWindow({
    width: 390, height: 420, x: Math.max(a.x, Math.min(b.x - 400, a.x + a.width - 390)), y: Math.max(a.y, Math.min(b.y, a.y + a.height - 420)),
    title: '送给月下的礼物', resizable: false, alwaysOnTop: true, autoHideMenuBar: true, webPreferences: petPreferences(),
  });
  gifts.loadURL(ORIGIN + '/gifts.html');
  gifts.on('closed', () => { gifts = null; giftMode(false); });
  lockDown(gifts);
}

// ---------------------------------------------------------------- 气泡
function placeBubble() {
  if (!bubble || bubble.isDestroyed() || !win) return;
  const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
  const scale = b.width / 384;
  let x = Math.round(b.x + HEAD_ANCHOR.x * scale - BUBBLE_SIZE.width / 2);
  // 头顶状态栏显示时，气泡放在状态栏上面
  const lift = headbar && !headbar.isDestroyed() && headbar.isVisible() ? HEADBAR_SIZE.height : 0;
  let y = Math.round(b.y + HEAD_ANCHOR.y * scale - BUBBLE_SIZE.height - lift);
  x = Math.max(a.x, Math.min(x, a.x + a.width - BUBBLE_SIZE.width));
  y = Math.max(a.y, y);
  bubble.setBounds({ x, y, ...BUBBLE_SIZE });
  // 尾巴始终指向月下头顶：屏幕边缘把气泡推开时，告诉页面尾巴的新横坐标
  bubble.webContents.send('companion:tail', Math.round(b.x + HEAD_ANCHOR.x * scale - x));
}

function updateBubbleVisibility() {
  if (!bubble || bubble.isDestroyed()) return;
  const show = bubbleWanted && bubbleIdle && win?.isVisible();
  if (show && !bubble.isVisible()) { placeBubble(); bubble.showInactive(); log('bubble show ' + JSON.stringify(bubble.getBounds())); }
  else if (!show && bubble.isVisible()) { bubble.hide(); log('bubble hide'); }
  else if (bubbleWanted && !show) log(`bubble held: idle=${bubbleIdle} petVisible=${win?.isVisible()}`);
}

function createBubble() {
  bubble = new BrowserWindow({
    ...BUBBLE_SIZE, show: false, transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: uiPreferences(),
  });
  bubble.setIgnoreMouseEvents(true, { forward: true });
  bubble.loadURL(ORIGIN + '/companion/bubble.html');
  lockDown(bubble);
}

// ---------------------------------------------------------------- 头顶状态栏（左 Codex 额度、中间状态、右 DeepSeek 余额）
function placeHeadbar() {
  if (!headbar || headbar.isDestroyed() || !win) return;
  const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
  const scale = b.width / 384;
  let x = Math.round(b.x + HEAD_ANCHOR.x * scale - HEADBAR_SIZE.width / 2);
  let y = Math.round(b.y + HEAD_ANCHOR.y * scale - HEADBAR_SIZE.height);
  x = Math.max(a.x, Math.min(x, a.x + a.width - HEADBAR_SIZE.width));
  y = Math.max(a.y, y);
  headbar.setBounds({ x, y, ...HEADBAR_SIZE });
}

/** 只在月下待机大小时显示（扩窗表演时头顶位置会变），并跟着「头顶状态栏」开关。 */
function updateHeadbarVisibility() {
  if (!headbar || headbar.isDestroyed()) return;
  const show = headbarOn && bubbleIdle && !!win?.isVisible();
  if (show && !headbar.isVisible()) { placeHeadbar(); headbar.showInactive(); }
  else if (!show && headbar.isVisible()) headbar.hide();
  if (bubble?.isVisible()) placeBubble();
}

function createHeadbar() {
  headbar = new BrowserWindow({
    ...HEADBAR_SIZE, show: false, transparent: true, frame: false, resizable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: uiPreferences(),
  });
  headbar.loadURL(ORIGIN + '/companion/headbar.html');
  headbar.once('ready-to-show', updateHeadbarVisibility);
  lockDown(headbar);
}

// ---------------------------------------------------------------- 控制台
function openConsole(tab = 'chat') {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.webContents.send('companion:tab', tab);
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return;
  }
  const a = screen.getDisplayMatching(win ? win.getBounds() : screen.getPrimaryDisplay().bounds).workArea;
  const width = Math.min(1040, a.width - 40), height = Math.min(700, a.height - 40);
  consoleWin = new BrowserWindow({
    width, height, minWidth: 860, minHeight: 580, x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2),
    frame: false, backgroundColor: '#120d16', title: '月下 · 控制台', show: false, webPreferences: uiPreferences(),
  });
  consoleWin.loadURL(ORIGIN + '/companion/console.html#' + encodeURIComponent(tab));
  consoleWin.once('ready-to-show', () => consoleWin.show());
  consoleWin.on('closed', () => { consoleWin = null; });
  lockDown(consoleWin);
}

// ---------------------------------------------------------------- 月下卡片（精简对话框，放在桌宠旁边）
const CARD_SIZE = { width: 372, height: 560 };
function placeCard() {
  const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
  // 优先放在月下左侧，放不下就放右侧；底边与桌宠对齐
  let x = b.x + 120 - CARD_SIZE.width;
  if (x < a.x) x = b.x + b.width - 40;
  x = Math.max(a.x, Math.min(x, a.x + a.width - CARD_SIZE.width));
  const y = Math.max(a.y, Math.min(b.y + b.height - CARD_SIZE.height, a.y + a.height - CARD_SIZE.height));
  return { x: Math.round(x), y: Math.round(y), ...CARD_SIZE };
}

function openCard() {
  if (statusWin && !statusWin.isDestroyed()) statusWin.hide(); // 打开聊天时收起状态卡
  if (cardWin && !cardWin.isDestroyed()) {
    if (!cardWin.isVisible()) cardWin.setBounds(placeCard());
    cardWin.show();
    cardWin.focus();
    cardWin.webContents.send('companion:tab', 'focus');
    return;
  }
  cardWin = new BrowserWindow({
    ...placeCard(), show: false, frame: false, transparent: true, resizable: true, minWidth: 330, minHeight: 420, alwaysOnTop: true,
    skipTaskbar: false, hasShadow: false, backgroundColor: '#00000000', title: '月下', webPreferences: uiPreferences(),
  });
  cardWin.loadURL(ORIGIN + '/companion/card.html');
  cardWin.once('ready-to-show', () => { cardWin.show(); cardWin.focus(); });
  cardWin.on('closed', () => { cardWin = null; });
  lockDown(cardWin);
}

// ---------------------------------------------------------------- 状态卡（单击月下弹出的微型面板）
const STATUS_SIZE = { width: 322, height: 240 };
let statusTimer = null, statusHovered = false;
function placeStatus() {
  const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
  let x = b.x + 130 - STATUS_SIZE.width;
  if (x < a.x) x = b.x + b.width - 60;
  x = Math.max(a.x, Math.min(x, a.x + a.width - STATUS_SIZE.width));
  const y = Math.max(a.y, Math.min(b.y + Math.round((b.height - STATUS_SIZE.height) / 2), a.y + a.height - STATUS_SIZE.height));
  return { x: Math.round(x), y: Math.round(y), ...STATUS_SIZE };
}
function scheduleStatusHide(ms = 8000) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { if (!statusHovered && statusWin && !statusWin.isDestroyed()) statusWin.hide(); }, ms);
}
function toggleStatus(force) {
  if (statusWin && !statusWin.isDestroyed() && statusWin.isVisible() && force !== true) { statusWin.hide(); return; }
  if (!statusWin || statusWin.isDestroyed()) {
    statusWin = new BrowserWindow({
      ...placeStatus(), show: false, frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true,
      hasShadow: false, backgroundColor: '#00000000', title: '月下 · 状态', webPreferences: uiPreferences(),
    });
    statusWin.loadURL(ORIGIN + '/companion/status.html');
    statusWin.once('ready-to-show', () => { statusWin.showInactive(); scheduleStatusHide(); });
    statusWin.on('closed', () => { statusWin = null; });
    lockDown(statusWin);
    return;
  }
  statusWin.setBounds(placeStatus());
  statusWin.showInactive();
  statusWin.webContents.send('companion:tab', 'refresh');
  scheduleStatusHide();
}

// ---------------------------------------------------------------- 右键菜单
async function companionMenu() {
  try { companion = await api('/state'); } catch { companion = null; }
  const link = companion?.settings.link || 'none';
  const voiceOn = !!companion?.settings.voice.enabled;
  const setLink = (value) => void api('/settings', 'PUT', { link: value });
  return [
    { type: 'separator' },
    { label: '和月下聊天 / 派活…', click: openCard },
    { label: '月下控制台…', click: () => openConsole('home') },
    {
      label: '联动',
      submenu: [
        { label: '独立陪伴', type: 'radio', checked: link === 'none', click: () => setLink('none') },
        { label: 'Codex', type: 'radio', checked: link === 'codex', click: () => setLink('codex') },
        { label: 'DeepSeek Harness', type: 'radio', checked: link === 'dsh', click: () => setLink('dsh') },
      ],
    },
    { label: '语音', type: 'checkbox', checked: voiceOn, enabled: !!companion, click: (item) => void api('/settings', 'PUT', { voice: { enabled: item.checked } }) },
    {
      label: '头顶状态栏', type: 'checkbox', checked: headbarOn,
      click: (item) => { headbarOn = item.checked; updateHeadbarVisibility(); void api('/settings', 'PUT', { headbar: headbarOn }).catch(() => {}); },
    },
  ];
}

async function showMenu() {
  const categories = manifest.categories.map((c) => ({
    label: c.name,
    submenu: c.actions.filter((id) => manifest.actions[id]).map((id) => ({ label: manifest.actions[id].name, click: () => send('pet:action', id) })),
  }));
  const extra = await companionMenu();
  Menu.buildFromTemplate([
    ...categories,
    { label: '礼物', submenu: manifest.gifts.map((g) => ({ label: g.name + '…', click: openGifts })) },
    {
      label: '自动触发动作', type: 'checkbox', checked: automatic,
      // 记进设置：重启后保持，控制台的「自动播放动作」同步
      click: (i) => { automatic = i.checked; send('pet:auto', automatic); void api('/settings', 'PUT', { autoPlay: automatic }).catch(() => {}); },
    },
    { label: '回到待机', click: () => send('pet:reset') },
    ...extra,
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: win });
}

// ---------------------------------------------------------------- 启动
app.on('second-instance', () => { win?.show(); win?.focus(); });

app.whenReady().then(async () => {
  if (!lock) return;
  await ensureServer(process.execPath);
  const state = await api('/state');
  basePath = state.base.path;
  if (!state.base.ok) throw new Error('找不到月下动作包：' + basePath);
  manifest = await (await fetch(ORIGIN + '/manifest.json')).json();
  viewports = layoutViewports(manifest.layout);
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: 384, height: 320, x: x + Math.max(128, width - 750), y: y + Math.max(90, height - 370), transparent: true, frame: false,
    resizable: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: petPreferences(),
  });
  win.loadURL(ORIGIN + '/preview.html?desktop=1');
  lockDown(win);
  win.on('move', () => { placeHeadbar(); placeBubble(); if (statusWin && !statusWin.isDestroyed() && statusWin.isVisible()) statusWin.setBounds(placeStatus()); });
  createBubble();
  headbarOn = state.settings.headbar !== false;
  createHeadbar();
  win.on('show', updateHeadbarVisibility);
  win.on('hide', updateHeadbarVisibility);

  const fromPet = (e) => e.sender === win.webContents;
  ipcMain.on('pet:viewport', (e, w, h) => {
    if (!fromPet(e)) return;
    const target = viewports.find((v) => v.canvas[0] === w && v.canvas[1] === h);
    if (!target) return;
    const b = win.getBounds(), a = screen.getDisplayMatching(b).workArea;
    const nx = b.x + offset[0] - target.offset[0], ny = b.y + offset[1] - target.offset[1];
    win.setBounds({ x: Math.max(a.x, Math.min(nx, a.x + a.width - target.size[0])), y: Math.max(a.y, Math.min(ny, a.y + a.height - target.size[1])), width: target.size[0], height: target.size[1] });
    offset = target.offset.slice();
    bubbleIdle = target.offset[0] === 0 && target.offset[1] === 0 && target.size[0] === 384;
    updateHeadbarVisibility();
    updateBubbleVisibility();
  });
  ipcMain.on('pet:close', (e) => { if (fromPet(e)) app.quit(); });
  ipcMain.on('pet:pass', (e, value) => {
    if (fromPet(e) && typeof value === 'boolean') { pass = value; if (!gifting) win.setIgnoreMouseEvents(pass, { forward: true }); }
  });
  ipcMain.on('pet:gifts', (e) => { if (fromPet(e)) openGifts(); });
  ipcMain.on('pet:gift-drag', (e, value) => { if (fromPet(e)) giftMode(value); });
  ipcMain.on('pet:gift-point', (e, kind, gx, gy, id) => {
    if (!gifts || e.sender !== gifts.webContents || !Number.isFinite(gx) || !Number.isFinite(gy)) return;
    const b = gifts.getContentBounds(), target = win.getContentBounds(), sx = b.x + gx, sy = b.y + gy;
    if (kind === 'start') {
      if (gifting || !manifest.gifts.some((g) => g.id === id)) return;
      giftMode(true);
      ghost = new BrowserWindow({
        width: 72, height: 72, x: Math.round(sx - 36), y: Math.round(sy - 36), transparent: true, frame: false, resizable: false, focusable: false,
        skipTaskbar: true, alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      ghost.setIgnoreMouseEvents(true);
      ghost.loadURL(ORIGIN + '/gift-ghost.html?gift=' + encodeURIComponent(id));
    } else if (kind === 'move' && gifting) ghost?.setPosition(Math.round(sx - 36), Math.round(sy - 36));
    else if (kind === 'end' && gifting) { send('pet:gift-drop', id, sx - target.x, sy - target.y); giftMode(false); }
    else if (kind === 'cancel') giftMode(false);
  });
  ipcMain.on('pet:menu', (e) => { if (fromPet(e)) void showMenu(); });
  ipcMain.on('pet:auto-state', (e, value) => { if (fromPet(e)) automatic = !!value; });
  ipcMain.on('pet:drag', (e, kind, dx, dy) => {
    if (!fromPet(e) || !Number.isFinite(dx) || !Number.isFinite(dy) || gifting) return;
    if (kind === 'start') drag = { x: dx, y: dy, position: win.getPosition() };
    else if (kind === 'move' && drag) win.setPosition(Math.round(drag.position[0] + dx - drag.x), Math.round(drag.position[1] + dy - drag.y));
    else if (kind === 'end') drag = null;
  });

  // 陪伴版新增的通道
  const ours = (e) => [win, bubble, gifts, cardWin, consoleWin, statusWin, headbar].some((w) => w && !w.isDestroyed() && e.sender === w.webContents);
  ipcMain.on('companion:console', (e, tab) => { if (ours(e)) openConsole(String(tab || 'home')); });
  ipcMain.on('companion:card', (e) => { if (ours(e)) openCard(); });
  ipcMain.on('companion:status', (e) => { if (e.sender === win.webContents) toggleStatus(); });
  // 头顶状态栏点左右圆环：打开状态卡（要看的工具已由页面写入 localStorage）
  ipcMain.on('companion:open-status', (e) => { if (headbar && e.sender === headbar.webContents) toggleStatus(true); });
  ipcMain.on('companion:status-hover', (e, value) => {
    if (!statusWin || e.sender !== statusWin.webContents) return;
    statusHovered = !!value;
    if (!statusHovered) scheduleStatusHide(3000);
  });
  ipcMain.handle('companion:pick-folder', async (e, current) => {
    if (!ours(e)) return null;
    const owner = BrowserWindow.fromWebContents(e.sender);
    const result = await dialog.showOpenDialog(owner, { title: '选择让月下派活的任务目录', defaultPath: current || undefined, properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.on('companion:bubble-pass', (e, value) => {
    if (bubble && e.sender === bubble.webContents) bubble.setIgnoreMouseEvents(!!value, { forward: true });
  });
  ipcMain.on('companion:bubble-visible', (e, value) => {
    if (bubble && e.sender === bubble.webContents) { bubbleWanted = !!value; updateBubbleVisibility(); }
  });
  ipcMain.on('companion:window', (e, action) => {
    const target = [consoleWin, cardWin].find((w) => w && !w.isDestroyed() && e.sender === w.webContents);
    if (!target) return;
    if (action === 'minimize') target.minimize();
    else if (action === 'maximize') target.isMaximized() ? target.unmaximize() : target.maximize();
    else if (action === 'close') target === cardWin ? target.hide() : target.close();
    else if (action === 'pin' || action === 'unpin') target.setAlwaysOnTop(action === 'pin');
  });

  if (process.argv.includes('--console')) openConsole('home');
  if (process.argv.includes('--card')) openCard();
  if (process.argv.includes('--status')) setTimeout(() => toggleStatus(true), 3000);
  if (process.env.YUEXIA_CAPTURE_DIR) scheduleCaptures(process.env.YUEXIA_CAPTURE_DIR);
}).catch((error) => {
  console.error(error);
  log('startup failed: ' + (error && error.stack || error));
  app.quit();
});

// 调试用：只截取陪伴版自己的窗口（不截屏幕），连同窗口位置写到指定目录
function scheduleCaptures(dir) {
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });
  const capture = async (tag) => {
    const bounds = {};
    for (const [name, target] of [['pet', win], ['headbar', headbar], ['bubble', bubble], ['console', consoleWin], ['card', cardWin], ['status', statusWin]]) {
      if (!target || target.isDestroyed()) continue;
      bounds[name] = { ...target.getBounds(), visible: target.isVisible() };
      if (!target.isVisible()) continue;
      const image = await target.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${tag}-${name}.png`), image.toPNG());
    }
    fs.writeFileSync(path.join(dir, `${tag}-bounds.json`), JSON.stringify(bounds, null, 2));
  };
  for (const [delay, tag] of [[6000, 'a'], [16000, 'b'], [30000, 'c']]) setTimeout(() => void capture(tag).catch(() => {}), delay);
}

let quitting = false;
app.on('before-quit', (event) => {
  clearTimeout(giftTimer);
  if (quitting) return;
  // 关闭桌宠时一并停掉陪伴服务（它会停掉自己启动的语音服务）
  quitting = true;
  event.preventDefault();
  api('/shutdown', 'POST', {}).catch(() => {}).finally(() => app.quit());
  setTimeout(() => app.exit(0), 2500);
});
app.on('window-all-closed', () => app.quit());
