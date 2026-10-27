'use strict';
// 语音合成设备检测：有可用的 NVIDIA 显卡就让 GPT-SoVITS 跑在 GPU 上，不在 CPU 上硬撑。
// 判断依据有两层：系统里有没有 NVIDIA 显卡（nvidia-smi / 显示适配器列表），
// 以及语音环境里的 PyTorch 能不能真正用上 CUDA（CPU 版 PyTorch 即使有显卡也用不了）。
// 结果缓存在数据目录的 gpu.json，Python 环境或显卡变化后自动重测。
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const TORCH_PROBE = [
  'import json, torch',
  'ok = torch.cuda.is_available()',
  'print(json.dumps({"torch": torch.__version__, "cuda": torch.version.cuda, "available": ok,',
  '  "name": torch.cuda.get_device_name(0) if ok else None,',
  '  "memoryMB": int(torch.cuda.get_device_properties(0).total_memory / 1048576) if ok else None}))',
].join('\n');

function run(command, args, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
    } catch {
      resolve(null);
    }
  });
}

/** 显示适配器名称（Windows），用于说明为什么没有用 GPU。 */
async function adapters() {
  const out = await run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
  return out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out.split(/\r?\n/).map((line) => {
    const [name, memory, driver] = line.split(',').map((s) => s.trim());
    return { name, memoryMB: Number(memory) || null, driver };
  });
}

async function torchInfo(python) {
  if (!fs.existsSync(python)) return null;
  const out = await run(python, ['-I', '-c', TORCH_PROBE], 120000);
  try { return out ? JSON.parse(out.split(/\r?\n/).pop()) : null; } catch { return null; }
}

/**
 * 决定语音用哪个设备。preference：auto | cuda | cpu。
 * 返回 { device, half, reason, nvidia, adapters, torch, checkedAt }。
 */
async function detect({ python, preference = 'auto' }) {
  const [gpus, names, torch] = await Promise.all([nvidia(), adapters(), torchInfo(python)]);
  const info = { nvidia: gpus, adapters: names, torch, checkedAt: new Date().toISOString() };
  const cudaReady = !!(info.torch && info.torch.available);
  if (preference === 'cpu') return { ...info, device: 'cpu', half: false, reason: '设置为始终使用 CPU' };
  if (cudaReady) {
    // 半精度在 CUDA 上更快、显存占用减半；显存很小的卡也能放下 v2Pro
    return { ...info, device: 'cuda', half: true, reason: `使用显卡 ${info.torch.name}（CUDA ${info.torch.cuda}）` };
  }
  if (info.nvidia.length) {
    const why = info.torch ? `语音环境里的 PyTorch ${info.torch.torch} 不支持 CUDA，需要换成 CUDA 版 PyTorch 才能用这张显卡` : '读不到语音环境的 PyTorch';
    return { ...info, device: 'cpu', half: false, reason: `检测到 ${info.nvidia[0].name}，但${why}`, needsCudaTorch: true };
  }
  const other = info.adapters.filter((n) => !/microsoft basic|remote|virtual|oray|idd|parsec|sunlogin|displaylink/i.test(n));
  const reason = other.length ? `显卡 ${other.join('、')} 不是 NVIDIA，GPT-SoVITS 只支持 CUDA，改用 CPU` : '没有检测到独立显卡，使用 CPU';
  return { ...info, device: 'cpu', half: false, reason: preference === 'cuda' ? '设置为使用 GPU，但' + reason : reason };
}

/** 带缓存的检测：Python 环境、偏好和 nvidia-smi 结果都没变时直接用上次的结论。 */
async function cachedDetect({ dataDir, python, preference }) {
  const file = path.join(dataDir, 'gpu.json');
  let stamp = '';
  try { stamp = String(fs.statSync(python).mtimeMs); } catch {}
  const key = JSON.stringify([python, stamp, preference, (await nvidia()).map((g) => g.name)]);
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cached.key === key) return cached.result;
  } catch {}
  const result = await detect({ python, preference });
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ key, result }, null, 1)); } catch {}
  return result;
}

/** 由原始 voice-server.yaml 生成指定设备的副本（只改 custom 段的 device / is_half）。 */
function deviceConfig(source, target, { device, half }) {
  const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/);
  let inCustom = false;
  const out = lines.map((line) => {
    if (/^\S/.test(line)) inCustom = /^custom:\s*$/.test(line);
    if (!inCustom) return line;
    if (/^\s+device:/.test(line)) return line.replace(/device:.*/, 'device: ' + device);
    if (/^\s+is_half:/.test(line)) return line.replace(/is_half:.*/, 'is_half: ' + (half ? 'true' : 'false'));
    return line;
  });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, out.join('\n'));
  return target;
}

module.exports = { detect, cachedDetect, deviceConfig, nvidia, adapters, torchInfo };
