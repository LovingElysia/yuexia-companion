'use strict';
// 把运行所需的程序和素材并进陪伴版目录，换到别的电脑时只拷这一个文件夹即可：
//   bundle.cjs runtime          复制 Electron 到 runtime\electron（来源：已找到的 Electron）
//   bundle.cjs pet [动作包目录]   从月下动作包挑出运行时用到的文件放进 pet\（同一磁盘用硬链接，不额外占空间）
//   bundle.cjs dist <目标目录>    导出发给别人的发布版：只含运行需要的文件
// 可以用 Electron 自身运行：set ELECTRON_RUN_AS_NODE=1 && runtime\electron\electron.exe tools\bundle.cjs pet
// 用 Electron 运行时，它会把 .asar 当成目录读；复制 Electron 自身时必须按普通文件处理
process.noAsar = true;
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ROOT, electronCandidates, ELECTRON_VERSION } = require('../lib/runtime.cjs');
const settings = require('../lib/settings.cjs');

function place(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { force: true });
  try {
    fs.linkSync(source, target);
    return 'link';
  } catch {
    fs.copyFileSync(source, target);
    return 'copy';
  }
}

function copyTree(source, target) {
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to);
    else { fs.mkdirSync(target, { recursive: true }); fs.copyFileSync(from, to); count++; }
  }
  return count;
}

function countFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);
}

function bundleRuntime() {
  const target = path.join(ROOT, 'runtime', 'electron');
  // 来源只取陪伴版目录之外的 Electron（npm 装的或系统里已有的），不拿上次没复制完的副本当来源
  const exe = electronCandidates().find((file) => path.resolve(path.dirname(file)) !== path.resolve(target) && fs.existsSync(file));
  if (!exe) throw new Error(`找不到 Electron ${ELECTRON_VERSION}：先在本目录运行 npm install，或设置 YUEXIA_ELECTRON_PATH`);
  const source = path.dirname(exe);
  const version = fs.existsSync(path.join(source, 'version')) ? fs.readFileSync(path.join(source, 'version'), 'utf8').trim() : '未知';
  console.log(`复制 Electron ${version}：${source} → ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
  const copied = copyTree(source, target), expected = countFiles(source);
  if (copied !== expected) throw new Error(`复制不完整：${copied}/${expected}`);
  // 界面语言包只留中文和英文（Chromium 至少需要一份）；其余 50 多种语言用不到
  let removed = 0;
  for (const name of fs.readdirSync(path.join(target, 'locales'))) {
    if (!KEEP_LOCALES.has(name)) { fs.rmSync(path.join(target, 'locales', name)); removed++; }
  }
  console.log(`完成，${copied - removed} 个文件（去掉 ${removed} 个用不到的语言包）`);
}

const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

// 发布版只带运行需要的文件：不含测试、node_modules 和开发记录
const DIST = ['desktop.cjs', 'server.cjs', 'launch.cjs', 'preload-pet.cjs', 'preload-ui.cjs', 'package.json', 'lib', 'web',
  'tools/check.cjs', 'tools/bundle.cjs', 'runtime', 'pet', '使用说明.md', '启动月下陪伴版.cmd', '打开月下控制台（浏览器）.cmd', '检测运行环境.cmd'];

function exportDist(targetArg) {
  if (!targetArg) throw new Error('用法：bundle.cjs dist <目标目录>');
  const target = path.resolve(targetArg);
  if (target === ROOT || target.startsWith(ROOT + path.sep)) throw new Error('目标目录不能在陪伴版目录里面');
  for (const need of ['runtime/electron/electron.exe', 'pet/manifest.json']) {
    if (!fs.existsSync(path.join(ROOT, need))) throw new Error('缺少 ' + need + '，先运行 bundle.cjs all');
  }
  let count = 0;
  for (const item of DIST) {
    const from = path.join(ROOT, item);
    if (!fs.existsSync(from)) continue;
    if (fs.statSync(from).isDirectory()) count += copyTree(from, path.join(target, item));
    else { fs.mkdirSync(path.dirname(path.join(target, item)), { recursive: true }); fs.copyFileSync(from, path.join(target, item)); count++; }
  }
  console.log(`发布版已导出到 ${target}，${count} 个文件`);
}

// manifest 里不会被播放器加载的字段：webm 是备用编码（播放器只解 webp），source / officialSource 是出处记录
const UNUSED_KEYS = new Set(['webm', 'source', 'officialSource']);
const ASSET = /^(?:assets|voice)\/[^\s]+\.(?:webp|png|jpg|wav|mp3|json)$/;

/** 动作包里运行时真正会加载的文件：页面与脚本、manifest，以及它们引用到的素材与配音。 */
function petFiles(base) {
  const files = new Set(['manifest.json', 'preload.cjs']);
  for (const name of fs.readdirSync(base)) if (/\.(html|js)$/.test(name)) files.add(name);
  JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'), (key, value) => {
    if (typeof value === 'string' && !UNUSED_KEYS.has(key) && ASSET.test(value)) files.add(value);
    return value;
  });
  for (const name of [...files]) {
    if (!/\.(html|js)$/.test(name)) continue;
    for (const m of fs.readFileSync(path.join(base, name), 'utf8').matchAll(/["'`]((?:assets|voice)\/[^"'`\s]+)["'`]/g)) if (ASSET.test(m[1])) files.add(m[1]);
  }
  return [...files].filter((f) => fs.existsSync(path.join(base, f))).sort();
}

function bundlePet(baseArg) {
  // 默认来源：设置里指定的动作包（不能是 pet\ 自己），否则 D:\pet 里的摩天轮包
  const configured = settings.load().basePackage;
  const base = path.resolve(baseArg || (configured && path.resolve(configured) !== path.join(ROOT, 'pet') ? configured : settings.LEGACY_PET));
  if (!fs.existsSync(path.join(base, 'manifest.json'))) throw new Error('不是月下动作包：' + base);
  const target = path.join(ROOT, 'pet');
  const files = petFiles(base);
  fs.rmSync(target, { recursive: true, force: true });
  const modes = { link: 0, copy: 0 };
  let bytes = 0;
  const list = [];
  for (const file of files) {
    const from = path.join(base, file);
    modes[place(from, path.join(target, file))]++;
    const size = fs.statSync(from).size;
    bytes += size;
    list.push({ file, size, sha256: file.endsWith('.json') || /\.(js|html|cjs)$/.test(file) ? crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex') : undefined });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(target, 'BUNDLE.json'), JSON.stringify({ source: base, manifest: manifest.id, created: new Date().toISOString(), files: list }, null, 1));
  console.log(`动作包 ${manifest.id}：${files.length} 个文件，${(bytes / 1e6).toFixed(0)} MB（硬链接 ${modes.link}，复制 ${modes.copy}）→ ${target}`);
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'runtime') bundleRuntime();
  else if (command === 'pet') bundlePet(arg);
  else if (command === 'all') { bundleRuntime(); bundlePet(arg); }
  else if (command === 'dist') exportDist(arg);
  else console.log('用法：bundle.cjs runtime | pet [动作包目录] | all | dist <目标目录>');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
