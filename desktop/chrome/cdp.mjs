import { t } from '../../shared/i18n.mjs';
import { EventEmitter } from 'node:events';

function validEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(url.pathname))
    throw new Error(t('올바른 전용 Chrome 연결 주소가 아니에요.'));
  return url.href;
}

export function chromeEndpoint(contents) {
  const [port, path] = String(contents).trim().split(/\r?\n/);
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error(t('Chrome 연결 정보를 확인하지 못했어요.'));
  return validEndpoint('ws://127.0.0.1:' + Number(port) + path);
}

export class CdpConnection extends EventEmitter {
  static async connect(endpoint, { WebSocketImpl = WebSocket, timeoutMs = 10000 } = {}) {
    const socket = new WebSocketImpl(validEndpoint(endpoint));
    await new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed); socket.removeEventListener('close', failed); };
      const opened = () => { clear(); resolve(); };
      const failed = () => { clear(); reject(new Error(t('Chrome 제어 연결을 열지 못했어요.'))); };
      const timer = setTimeout(() => { failed(); try { socket.close(); } catch {} }, timeoutMs);
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
    });
    return new CdpConnection(socket, timeoutMs);
  }
  constructor(socket, timeoutMs) {
    super();
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    socket.addEventListener('message', event => {
      if (this.closed) return;
      const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      if (text.length > 32 * 1024 * 1024) { this.close(); return; }
      let message;
      try { message = JSON.parse(text); } catch { this.close(); return; }
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        if (request.sessionId !== message.sessionId) { this.close(); return; }
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(String(message.error.message || 'Chrome command failed').slice(0, 300)));
        else request.resolve(message.result || {});
      } else if (typeof message.method === 'string') this.emit('event', message);
    });
    socket.addEventListener('close', () => this.close());
    socket.addEventListener('error', () => this.close());
  }
  async send(method, params = {}, sessionId) {
    if (this.closed || this.socket.readyState !== 1) throw new Error(t('Chrome 연결이 닫혔어요. 다시 연결해 주세요.'));
    if (this.pending.size >= 128 || this.socket.bufferedAmount > 4 * 1024 * 1024)
      throw new Error(t('Chrome이 이전 명령을 처리 중이에요.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(t('Chrome 응답 시간이 초과됐어요.'))); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sessionId });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(t('Chrome 연결이 닫혔어요.'))); }
    this.pending.clear();
    try { if (this.socket.readyState < 2) this.socket.close(); } catch {}
    this.emit('closed');
  }
}
