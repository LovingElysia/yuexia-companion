// 控制台、气泡与注入脚本共用的请求封装（同源，写操作带自定义头以通过服务端的本机校验）。
export async function api(route, method = 'GET', body) {
  const response = await fetch('/api' + route, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-yuexia-companion': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !('ok' in data)) throw new Error(data.error || 'HTTP ' + response.status);
  return data;
}

/** SSE 订阅：断线后浏览器会自动重连；handlers 以事件名为键。
 *  优先经 SharedWorker 让所有窗口共用一条连接：各窗口各开一条会占满 Chromium 对同一主机 6 条连接的上限，
 *  之后的普通请求全部排队（见 events-worker.js）。没有 SharedWorker 时退回每个窗口自己连接。 */
export function subscribe(handlers) {
  if (typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker('/companion/events-worker.js', { name: 'yuexia-events' });
      worker.port.onmessage = ({ data }) => {
        const fn = handlers[data?.name];
        if (!fn) return;
        try { fn(JSON.parse(data.data)); } catch (error) { console.error(data.name, error); }
      };
      worker.port.start();
      worker.port.postMessage({ type: 'listen', names: Object.keys(handlers) });
      addEventListener('pagehide', () => worker.port.postMessage({ type: 'close' }));
      return worker.port;
    } catch (error) {
      console.warn('SharedWorker 不可用，改为本窗口单独连接', error);
    }
  }
  const source = new EventSource('/api/events');
  for (const [name, fn] of Object.entries(handlers)) {
    source.addEventListener(name, (event) => {
      try { fn(JSON.parse(event.data)); } catch (error) { console.error(name, error); }
    });
  }
  return source;
}
