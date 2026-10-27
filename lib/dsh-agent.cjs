'use strict';
// 让月下替你给 DeepSeek Harness 派活：调用 DSH 桌面版自带的命令行 `dsh headless --json`，
// 在任务目录里执行一轮任务并逐行读取它的运行事件（status / thinking / text / tool_call / final）。
// 同一个月下对话里的后续任务用 --session-id 续接同一个 DSH 会话。
// 无头模式走 DeepSeek 官方接口，需要 DEEPSEEK_API_KEY：这里用你在控制台保存的同一个 DeepSeek 密钥，
// 只放进子进程的环境变量，不写入 DSH 的配置。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const CLI = path.join('resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');

function runningApp() {
  return new Promise((resolve) => {
    // 安装目录可能含中文（例如“新建文件夹”）：强制 UTF-8 输出，否则路径会乱码
    execFile('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path"],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(error ? null : String(stdout).trim() || null));
  });
}

/** DSH 安装时登记的 dsh:// 链接处理程序，就是 DeepSeek Harness.exe 本身（DSH 没在运行时也能找到）。 */
function registeredApp() {
  return new Promise((resolve) => {
    const script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Classes\\dsh\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'";
    execFile('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => {
      const match = !error && String(stdout).match(/"([^"]+\.exe)"/i);
      resolve(match ? match[1] : null);
    });
  });
}

/** 找 DSH 桌面版：设置里的路径 → 正在运行的进程 → dsh:// 链接登记的程序 → 常见安装位置。 */
async function findDsh(configured) {
  const candidates = [configured, process.env.YUEXIA_DSH, await runningApp(), await registeredApp(),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe')];
  // CLI 在 app.asar 包内，只有 Electron 能看到包里的文件；这里只确认包本身存在
  return candidates.find((exe) => exe && fs.existsSync(exe) && fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'))) || null;
}

const DETAIL_LIMIT = 20000;
const clip = (text) => {
  const value = String(text ?? '');
  return value.length > DETAIL_LIMIT ? value.slice(0, DETAIL_LIMIT) + `\n…（其余 ${value.length - DETAIL_LIMIT} 字省略）` : value;
};
const json = (value) => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** 工具调用的标题：优先用 DSH 自己写的 description，其次是命令本身。 */
function toolTitle(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const brief = i.description || i.command || i.path || i.file_path || i.query || i.url || '';
  return tool + (brief ? '：' + String(brief).split(/\r?\n/)[0].slice(0, 120) : '');
}

function toolLabel(name) {
  const tool = String(name || '').toLowerCase();
  if (/edit|write|patch/.test(tool)) return '正在修改文件';
  if (/pwsh|shell|bash|run_code|exec|terminal/.test(tool)) return '正在运行命令';
  if (/read|view|glob|grep|list/.test(tool)) return '正在读取文件';
  if (/web|search|fetch/.test(tool)) return '正在查找资料';
  return '正在使用工具 ' + name;
}

class DshAgent {
  constructor({ getSettings, onEvent, log = () => {} }) {
    this.getSettings = getSettings;
    this.onEvent = onEvent;
    this.log = log;
    this.child = null;
    this.session = null; // { id, cwd }
    this.exe = null;
    this.status = 'idle';
    this.detail = '';
  }

  snapshot() {
    return { status: this.status, detail: this.detail, exe: this.exe, sessionId: this.session?.id || null, cwd: this.session?.cwd || null, working: !!this.child };
  }

  emit(event) {
    this.onEvent({ target: 'dsh', ...event });
  }

  /** sessionId 为空时开新的 DSH 会话，否则用 --session-id 续接。 */
  async dispatch(text, cwd, sessionId = null) {
    if (this.child) throw new Error('DeepSeek Harness 还在处理上一件事');
    const settings = this.getSettings();
    this.exe = await findDsh(settings.dsh.app);
    if (!this.exe) throw new Error('没有找到 DeepSeek Harness 桌面版：请先安装，或在控制台「联动」里指定 DeepSeek Harness.exe');
    if (!settings.chat.apiKey) throw new Error('DSH 无头模式需要 DeepSeek API 密钥：请在控制台「人设与模型」里保存');
    this.session = sessionId ? { id: sessionId, cwd } : null;
    const args = ['--expose-internals', path.join(path.dirname(this.exe), CLI), 'headless', '--json'];
    if (this.session) args.push('--session-id', this.session.id);
    args.push('-');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEEPSEEK_API_KEY: settings.chat.apiKey };
    const child = spawn(this.exe, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.interrupted = false;
    this.status = 'working';
    child.stdin.end(text); // 任务从标准输入传入，避免命令行长度与引号问题
    let buffer = '', stderr = '', finalText = '', failure = null, finished = false;
    // 步骤：DSH 的 step 编号原样使用；说明文字要等下一件事发生才知道不是最终回答，先暂存
    let stepNo = 0, pendingText = null;
    const calls = new Map(); // callId -> 工具调用，等结果回来合成一步
    const step = (entry) => this.emit({ kind: 'step', step: { n: stepNo, ...entry } });
    const flushText = () => {
      if (pendingText) step({ type: 'text', title: '说明', detail: clip(pendingText) });
      pendingText = null;
    };
    const flushCalls = () => {
      for (const call of calls.values()) step({ ...call, status: 'unknown' });
      calls.clear();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'session') {
          this.session = { id: e.sessionId, cwd };
          this.emit({ kind: 'started', sessionId: e.sessionId });
        } else if (e.type === 'status' && e.phase === 'step_start') {
          stepNo = Number(e.step) || stepNo + 1;
        } else if (e.type === 'tool_call') {
          flushText();
          calls.set(e.callId, { type: 'tool', title: toolTitle(e.tool, e.input), detail: '参数：\n' + clip(json(e.input)), tool: e.tool, n: stepNo });
          this.emit({ kind: 'progress', label: toolLabel(e.tool) });
        } else if (e.type === 'tool_result') {
          const call = calls.get(e.callId);
          calls.delete(e.callId);
          if (call) step({ ...call, detail: call.detail + '\n\n结果：\n' + clip(e.result), status: e.status === 'error' ? 'error' : 'ok' });
        } else if (e.type === 'thinking') {
          flushText();
          if (e.text) step({ type: 'thinking', title: '思考', detail: clip(e.text) });
          this.emit({ kind: 'progress', label: '正在思考' });
        } else if (e.type === 'text') {
          flushText();
          pendingText = e.text;
          this.emit({ kind: 'message', text: e.text, final: false });
        } else if (e.type === 'status' && e.phase === 'turn_end') {
          const kind = e.reason?.kind || 'completed';
          if (kind !== 'completed') failure = e.reason?.error?.message || ('任务结束：' + kind);
          finished = true;
        } else if (e.type === 'final') {
          finalText = e.text || '';
          // 最后一段说明就是最终回答：不再重复记成一步
          if (pendingText && pendingText.trim() !== finalText.trim()) flushText();
          pendingText = null;
        }
      }
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      this.status = 'idle';
      if (!finished && !failure) failure = (stderr.trim().split(/\r?\n/).pop() || `DSH 退出（代码 ${code}）`).replace(/^dsh:\s*/, '');
      flushCalls(); // 被中断时没有结果的工具调用也照样记下
      if (!finalText) flushText();
      if (finalText) this.emit({ kind: 'message', text: finalText, final: true });
      if (this.interrupted) this.emit({ kind: 'done', status: 'interrupted', error: null });
      else this.emit({ kind: 'done', status: failure ? 'failed' : 'completed', error: failure });
    });
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.status = 'idle';
      this.emit({ kind: 'done', status: 'failed', error: error.message });
    });
    return { sessionId: this.session?.id || null };
  }

  interrupt() {
    const child = this.child;
    if (!child) return false;
    this.interrupted = true;
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return true;
  }

  reset() {
    this.session = null;
  }
}

module.exports = { DshAgent, findDsh, toolLabel, toolTitle, CLI };
