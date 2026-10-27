// 所有陪伴版窗口共用的一条 SSE 连接（SharedWorker）。
// Electron 的窗口共用同一个网络会话，Chromium 对同一主机最多保持 6 条连接；桌宠页、气泡、头顶状态栏、
// 状态卡、月下卡片、控制台各开一条 SSE 就会把它占满，之后的普通请求全部排队、窗口看起来没有反应。
// 服务端只在连接建立时发一次完整的 state，所以这里记住最近一次 state，新窗口接入时先补发给它。
const ports = new Set();
const names = new Set();
const latest = new Map(); // 事件名 -> 最近一次的数据（只记完整快照类的事件）
const SNAPSHOT = new Set(['state']);
let source = null;

function relay(name) {
  source.addEventListener(name, (event) => {
    if (SNAPSHOT.has(name)) latest.set(name, event.data);
    for (const port of ports) port.postMessage({ name, data: event.data });
  });
}

function connect() {
  if (source) return;
  source = new EventSource('/api/events');
  for (const name of names) relay(name);
}

self.onconnect = (event) => {
  const port = event.ports[0];
  ports.add(port);
  port.onmessage = ({ data }) => {
    if (data?.type === 'listen') {
      for (const name of data.names) {
        if (!names.has(name)) { names.add(name); if (source) relay(name); }
        if (latest.has(name)) port.postMessage({ name, data: latest.get(name) });
      }
      connect();
    } else if (data?.type === 'close') {
      ports.delete(port);
    }
  };
  port.start();
};
