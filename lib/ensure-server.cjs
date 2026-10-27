'use strict';
// 确保陪伴服务在运行：先探测 /health，没有就以独立后台进程启动 server.cjs 并等待就绪。
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.YUEXIA_COMPANION_PORT || 18766);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(ORIGIN + '/health', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).name === 'yuexia-companion'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => req.destroy());
  });
}

async function ensureServer(nodePath = process.execPath) {
  if (await ping()) return ORIGIN;
  const env = { ...process.env };
  // 在 Electron 主进程里调用时，用 Electron 自带的 Node 模式运行服务
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(nodePath, [path.join(__dirname, '..', 'server.cjs')], {
    cwd: path.join(__dirname, '..'), detached: true, stdio: 'ignore', windowsHide: true, env,
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (await ping()) return ORIGIN;
  }
  throw new Error('月下陪伴服务未能启动（端口 ' + PORT + '）');
}

module.exports = { ensureServer, ping, ORIGIN, PORT };
