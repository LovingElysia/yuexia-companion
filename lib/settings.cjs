'use strict';
// 陪伴版设置：存放在 %LOCALAPPDATA%\YuexiaCompanion\settings.json（可用 YUEXIA_COMPANION_HOME 改位置）。
// 只有这一处读写设置文件；对外给出的 publicView() 不含 API 密钥原文。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = process.env.YUEXIA_COMPANION_HOME
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'YuexiaCompanion');
const FILE = path.join(DATA_DIR, 'settings.json');

const LINKS = ['none', 'codex', 'dsh'];
// 陪伴版自带动作包之前的默认值：保存过这个路径的旧设置视为“自动”
const LEGACY_PET = path.resolve(__dirname, '..', '..', 'actions', 'amusement-06-ferris-wheel');
const PROVIDERS = ['off', 'openai'];
const EMOTIONS = ['neutral', 'relaxed', 'shy', 'sad', 'happy', 'surprised', 'curious', 'angry'];

function defaults() {
  return {
    version: 1,
    // 动作素材与播放器来自哪个月下动作包；留空 = 自动（陪伴版自带的 pet，没有时用 D:pet 里的摩天轮包）
    basePackage: '',
    link: 'none',
    codex: { home: '', workdir: '', sandbox: 'workspace-write', exe: '' },
    dsh: { home: '', workdir: '', app: '' },
    // 月下卡片当前把话交给谁：chat = 对话模型，codex / dsh = 派活
    chatTarget: 'chat',
    // Codex 与 DSH 共用的提醒开关
    work: { speakStart: true, speakComplete: true, speakAbort: true, showTitle: true },
    chat: {
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com',
      model: '',
      apiKey: '',
      memoryRounds: 6,
      persona: '',
    },
    voice: {
      enabled: true,
      url: 'http://127.0.0.1:9880',
      autoStart: true,
      root: 'D:/Development/GPT-SoVITS',
      profile: 'yuexia',
      device: 'auto', // auto：有可用的 NVIDIA 显卡就用 GPU | cuda | cpu
      speed: 1.0,
      volume: 0.9,
      speakChat: true,
      speakWork: true,
      idleOnly: true,
      // 合成快于实时（显卡）时边合成边播放；CPU 慢于实时，流式会断断续续，所以照旧整句合成后再播
      stream: true,
    },
    greeting: true,
    // 月下头顶的状态栏：左 Codex 额度、中间状态、右 DeepSeek 余额
    headbar: true,
    // 待机时偶尔自己表演动作（右键菜单「自动触发动作」）
    autoPlay: true,
  };
}

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (value, fallback, limit = 400) => (typeof value === 'string' ? value.trim().slice(0, limit) : fallback);
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

/** 粘贴的密钥常带着说明文字或空格：取出其中的密钥本身（优先 sk- 开头、至少 16 个可见 ASCII 字符），否则视为没有填。 */
function apiKeyOf(value) {
  if (typeof value !== 'string') return '';
  const runs = value.match(/[\x21-\x7e]{16,}/g) || [];
  return (runs.find((r) => r.startsWith('sk-')) || runs[0] || '').slice(0, 400);
}

/** http(s) 地址：保留路径（如 /v1），去掉末尾斜杠、查询串和片段。 */
function serviceUrl(value, fallback) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

/** 把任意输入收敛成合法设置：未知字段丢弃，非法值回落到 base（通常是当前设置或默认值）。 */
function normalize(input, base = defaults()) {
  const raw = input && typeof input === 'object' ? input : {};
  const codex = raw.codex || {}, dsh = raw.dsh || {}, chat = raw.chat || {}, voice = raw.voice || {};
  const work = raw.work || raw.codex || {}; // 旧版把提醒开关放在 codex 里
  return {
    version: 1,
    basePackage: raw.basePackage === undefined ? base.basePackage : (path.resolve(text(raw.basePackage, '', 1000) || '.') === LEGACY_PET ? '' : text(raw.basePackage, '', 1000)),
    link: oneOf(raw.link, LINKS, base.link),
    codex: {
      home: text(codex.home, base.codex.home, 1000),
      workdir: text(codex.workdir, base.codex.workdir, 1000),
      sandbox: oneOf(codex.sandbox, ['read-only', 'workspace-write', 'danger-full-access'], base.codex.sandbox),
      exe: text(codex.exe, base.codex.exe, 1000),
    },
    dsh: { home: text(dsh.home, base.dsh.home, 1000), workdir: text(dsh.workdir, base.dsh.workdir, 1000), app: text(dsh.app, base.dsh.app, 1000) },
    chatTarget: oneOf(raw.chatTarget, ['chat', 'codex', 'dsh'], base.chatTarget),
    work: {
      speakStart: flag(work.speakStart, base.work.speakStart),
      speakComplete: flag(work.speakComplete, base.work.speakComplete),
      speakAbort: flag(work.speakAbort, base.work.speakAbort),
      showTitle: flag(work.showTitle, base.work.showTitle),
    },
    chat: {
      provider: oneOf(chat.provider, PROVIDERS, base.chat.provider),
      baseUrl: chat.baseUrl === undefined ? base.chat.baseUrl : serviceUrl(chat.baseUrl, base.chat.baseUrl),
      model: text(chat.model, base.chat.model, 120),
      // 空字符串表示“不修改”，清除密钥用 clearApiKey
      apiKey: chat.clearApiKey === true ? '' : apiKeyOf(chat.apiKey) || apiKeyOf(base.chat.apiKey),
      memoryRounds: Math.round(clampNumber(chat.memoryRounds, 0, 30, base.chat.memoryRounds)),
      persona: text(chat.persona, base.chat.persona, 4000),
    },
    voice: {
      enabled: flag(voice.enabled, base.voice.enabled),
      url: voice.url === undefined ? base.voice.url : serviceUrl(voice.url, base.voice.url),
      autoStart: flag(voice.autoStart, base.voice.autoStart),
      root: text(voice.root, base.voice.root, 1000) || base.voice.root,
      profile: text(voice.profile, base.voice.profile, 80) || base.voice.profile,
      device: oneOf(voice.device, ['auto', 'cuda', 'cpu'], base.voice.device),
      speed: clampNumber(voice.speed, 0.6, 1.5, base.voice.speed),
      volume: clampNumber(voice.volume, 0, 1, base.voice.volume),
      speakChat: flag(voice.speakChat, base.voice.speakChat),
      speakWork: flag(voice.speakWork, base.voice.speakWork),
      idleOnly: flag(voice.idleOnly, base.voice.idleOnly),
      stream: flag(voice.stream, base.voice.stream),
    },
    greeting: flag(raw.greeting, base.greeting),
    headbar: flag(raw.headbar, base.headbar),
    autoPlay: flag(raw.autoPlay, base.autoPlay),
  };
}

/** 局部更新：只合并调用方给出的段落。 */
function merge(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  return normalize({
    ...current,
    ...p,
    codex: { ...current.codex, ...(p.codex || {}) },
    dsh: { ...current.dsh, ...(p.dsh || {}) },
    work: { ...current.work, ...(p.work || {}) },
    chat: { ...current.chat, apiKey: '', ...(p.chat || {}) },
    voice: { ...current.voice, ...(p.voice || {}) },
  }, current);
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return defaults();
  }
}

/** 先写临时文件再替换。本机 AppData 经过跨盘迁移，同目录 rename 也可能报 EXDEV，此时改为复制后删除。 */
function writeFileSafe(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, data);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
    fs.copyFileSync(temp, file);
    fs.rmSync(temp, { force: true });
  }
}

function save(settings) {
  writeFileSafe(FILE, JSON.stringify(settings, null, 2));
}

function publicView(settings) {
  const { apiKey, ...chat } = settings.chat;
  return { ...settings, chat: { ...chat, hasApiKey: !!apiKey, apiKeyHint: apiKey ? apiKey.slice(0, 3) + '…' + apiKey.slice(-4) : '' } };
}

/** 实际使用的动作包目录。 */
function petDir(settings) {
  if (settings.basePackage) return settings.basePackage;
  const bundled = path.join(__dirname, '..', 'pet');
  return fs.existsSync(path.join(bundled, 'manifest.json')) ? bundled : LEGACY_PET;
}

module.exports = { petDir, LEGACY_PET, DATA_DIR, FILE, LINKS, PROVIDERS, EMOTIONS, defaults, normalize, merge, load, save, publicView, writeFileSafe };
