'use strict';
// 启动入口（不需要另装 Node，可用自带 Electron 以 ELECTRON_RUN_AS_NODE=1 运行）：
//   launch.cjs desktop → 透明桌宠；launch.cjs console → 在浏览器打开控制台；launch.cjs preview → 网页预览。
const path = require('node:path');
const cp = require('node:child_process');
const { ensureServer } = require('./lib/ensure-server.cjs');
const { findElectron, electronCandidates } = require('./lib/runtime.cjs');

const electron = findElectron();
const mode = process.argv[2] || 'desktop';

(async () => {
  const origin = await ensureServer();
  if (mode === 'desktop') {
    if (!electron) throw new Error('找不到 Electron。请运行 tools\\bundle.cjs runtime 或 npm install。已查找：\n' + electronCandidates().join('\n'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = cp.spawn(electron, [path.join(__dirname, 'desktop.cjs')], { cwd: __dirname, env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    console.log('DESKTOP_PID', child.pid);
  } else {
    const page = mode === 'console' ? '/companion/console.html' : '/preview.html';
    cp.spawn('explorer.exe', [origin + page], { stdio: 'ignore', windowsHide: true }).unref();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
