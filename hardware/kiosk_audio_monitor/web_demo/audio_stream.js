// A persistent, bounded audio stream. Network recovery never owns the USB port.
export class AudioStream {
  constructor(url, { onReady, onEvent, onStatus, closeSession }, { maximumBytes = 300000 } = {}) {
    Object.assign(this, { url, onReady, onEvent, onStatus, closeSession, maximumBytes });
    this.active = false; this.ready = false; this.socket = null; this.epoch = 0;
    this.chunks = []; this.bytes = 0; this.session = null; this.retries = 0;
  }
  start() {
    this.active = true;
    this.timer = setInterval(() => this.pump(), 40);
    this.open();
  }
  open() {
    if (!this.active) return;
    const epoch = ++this.epoch;
    this.onStatus('connecting', this.retries ? '서버에 다시 연결하고 있어요. USB 마이크는 유지돼요.' : '음성 서버에 연결하고 있어요.');
    let socket;
    try { socket = this.socket = new WebSocket(this.url); }
    catch { void this.recover(epoch); return; }
    this.deadline = setTimeout(() => void this.recover(epoch), 12000);
    socket.onmessage = (event) => {
      if (!this.active || epoch !== this.epoch) return;
      try {
        const row = JSON.parse(event.data);
        this.lastEvent = Date.now();
        if (row.event === 'stream.ready') {
          clearTimeout(this.deadline); this.session = row.session; this.ready = true;
          const recovered = this.retries > 0; this.retries = 0;
          this.onReady(row.session);
          this.onStatus('ready', recovered ? '서버 연결을 복구했어요. 끊겼을 때 하신 말은 다시 말씀해 주세요.' : '연결됐어요. 평소 목소리로 자유롭게 말씀해 주세요.');
        } else if (row.event === 'stream.error') {
          this.onStatus('waiting', row.message); void this.recover(epoch, row.message);
        } else if (row.event === 'remote.closed') {
          void this.recover(epoch);
        } else this.onEvent(row);
      } catch { void this.recover(epoch); }
    };
    socket.onclose = () => void this.recover(epoch);
    socket.onerror = () => void this.recover(epoch);
  }
  push(data) {
    if (!this.active || !this.ready) return;
    this.chunks.push(data); this.bytes += data.length;
    if (this.bytes + (this.socket?.bufferedAmount || 0) > this.maximumBytes) {
      void this.recover(this.epoch, '전송 지연이 길어 서버 연결을 새로 잡고 있어요. 연결 후 이번 말만 다시 말씀해 주세요.');
    }
  }
  take() {
    const result = new Uint8Array(Math.min(32768, this.bytes)); let offset = 0;
    while (offset < result.length) {
      const head = this.chunks[0], count = Math.min(head.length, result.length - offset);
      result.set(head.subarray(0, count), offset); offset += count;
      if (count === head.length) this.chunks.shift(); else this.chunks[0] = head.subarray(count);
    }
    this.bytes -= result.length; return result;
  }
  pump() {
    const socket = this.socket;
    if (!this.active || !this.ready || socket?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastEvent > 15000) { void this.recover(this.epoch); return; }
    try {
      // No per-packet HTTP round trip. Drain a transient backlog immediately.
      while (this.bytes && socket.bufferedAmount < 65536) socket.send(this.take());
    } catch { void this.recover(this.epoch); }
  }
  async recover(epoch, message = '서버 연결이 잠시 끊겼어요. USB 마이크를 유지하고 다시 연결하고 있어요.') {
    if (!this.active || epoch !== this.epoch) return;
    const recovery = ++this.epoch, socket = this.socket, session = this.session;
    this.ready = false; this.socket = null; this.session = null; this.chunks = []; this.bytes = 0;
    clearTimeout(this.deadline); this.onStatus('reconnecting', message);
    // Kill this worker before reconnecting, so buffered/stale audio can't
    // publish a partial order or monopolize the next microphone session.
    try { if (session) await this.closeSession(session); } catch {}
    try { socket?.close(); } catch {}
    if (this.active && recovery === this.epoch) {
      this.retries++;
      this.retryTimer = setTimeout(() => this.open(), Math.min(3000, 300 * 2 ** Math.min(4, this.retries - 1)));
    }
  }
  async stop() {
    this.active = false; this.ready = false; this.epoch++;
    clearInterval(this.timer); clearTimeout(this.retryTimer); clearTimeout(this.deadline);
    const socket = this.socket, session = this.session;
    this.socket = null; this.session = null; this.chunks = []; this.bytes = 0;
    try { socket?.close(1000, 'Stopped'); } catch {}
    try { if (session) await this.closeSession(session); } catch {}
  }
}
