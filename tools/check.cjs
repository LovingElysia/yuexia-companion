'use strict';
// 安装 / 换电脑后运行一次：检查运行所需的程序和数据是否齐全，并决定语音用 GPU 还是 CPU。
// 用法：set ELECTRON_RUN_AS_NODE=1 && runtime\electron\electron.exe tools\check.cjs（或 node tools\check.cjs）
const fs = require('node:fs');
const path = require('node:path');
const settings = require('../lib/settings.cjs');
const gpu = require('../lib/gpu.cjs');
const { findElectron, bundledPet } = require('../lib/runtime.cjs');
const { codexHome } = require('../lib/codex.cjs');
const { dshHome } = require('../lib/dsh.cjs');

const ok = (label, detail) => console.log('  [好] ' + label + (detail ? '：' + detail : ''));
const warn = (label, detail) => console.log('  [注意] ' + label + (detail ? '：' + detail : ''));

(async () => {
  const s = settings.load();
  console.log('月下陪伴版 · 环境检测\n');
  const electron = findElectron();
  if (electron) ok('Electron', electron); else warn('Electron', '没有找到，请运行 npm install 或 tools\\bundle.cjs runtime');
  const pet = settings.petDir(s);
  if (fs.existsSync(path.join(pet, 'manifest.json'))) ok('动作包', pet + (bundledPet() ? '' : '（未并入陪伴版，可运行 tools\\bundle.cjs pet）'));
  else warn('动作包', '找不到 ' + pet);
  const root = s.voice.root, python = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(path.join(root, 'voice-server.py')) && fs.existsSync(python)) ok('GPT-SoVITS 语音服务', root);
  else warn('GPT-SoVITS 语音服务', '在 ' + root + ' 没找到 voice-server.py 与 .venv（可在控制台“语音 → 高级”改目录）');
  console.log('\n  正在检测显卡与 PyTorch（约 10 秒）…');
  const device = await gpu.detect({ python, preference: s.voice.device });
  for (const g of device.nvidia) console.log(`    NVIDIA：${g.name}，${g.memoryMB} MB，驱动 ${g.driver}`);
  if (device.adapters.length) console.log('    显示适配器：' + device.adapters.join('、'));
  if (device.torch) console.log(`    PyTorch ${device.torch.torch}，CUDA ${device.torch.cuda || '无'}`);
  (device.needsCudaTorch ? warn : ok)('语音合成设备 = ' + (device.device === 'cuda' ? 'GPU' : 'CPU'), device.reason);
  if (device.needsCudaTorch) console.log('    建议：在语音环境里安装 CUDA 版 PyTorch（与驱动匹配的 cu12x 版本），之后重新运行本检测。');
  fs.mkdirSync(settings.DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(settings.DATA_DIR, 'gpu.json'), JSON.stringify({ key: null, result: device }, null, 1));
  const codex = codexHome(s.codex.home), dsh = dshHome(s.dsh.home);
  (fs.existsSync(path.join(codex, 'sessions')) ? ok : warn)('Codex 会话日志', codex);
  (fs.existsSync(path.join(dsh, 'sessions')) ? ok : warn)('DeepSeek Harness 会话日志', dsh);
  console.log('\n设置与记录保存在：' + settings.DATA_DIR);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
