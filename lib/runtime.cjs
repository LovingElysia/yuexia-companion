'use strict';
// 陪伴版运行所需程序的查找顺序：先用陪伴版自带的（runtime\electron、npm 装的 node_modules\electron），
// 其次是用户显式指定的路径；~/.dsh/electron 只作为旧环境的最后兜底，不再是必需条件。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ELECTRON_VERSION = '43.3.0';

function electronCandidates() {
  return [
    path.join(ROOT, 'runtime', 'electron', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    process.env.YUEXIA_ELECTRON_PATH,
    process.env.DSH_PET_ELECTRON_PATH,
    path.join(os.homedir(), '.dsh', 'electron', 'electron.exe'),
  ].filter(Boolean);
}

function findElectron() {
  return electronCandidates().find((file) => fs.existsSync(file)) || null;
}

/** 陪伴版自带的动作包（tools/bundle.cjs pet 生成）；没有时回落到 D:\pet 里的摩天轮包。 */
function bundledPet() {
  const dir = path.join(ROOT, 'pet');
  return fs.existsSync(path.join(dir, 'manifest.json')) ? dir : null;
}

module.exports = { ROOT, ELECTRON_VERSION, electronCandidates, findElectron, bundledPet };
