import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('./web_demo/audio_stream.js', import.meta.url), 'utf8');
const { AudioStream } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
class Socket {
  static OPEN = 1;
  static all = [];
  constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; Socket.all.push(this); }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  message(row) { this.onmessage?.({ data: JSON.stringify(row) }); }
}
globalThis.WebSocket = Socket;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup() {
  Socket.all = []; const events = [], closed = [], statuses = [];
  const stream = new AudioStream('ws://fixture', { onReady: () => {}, onEvent: (r) => events.push(r), onStatus: (s) => statuses.push(s), closeSession: async (id) => closed.push(id) });
  stream.start(); Socket.all[0].message({ event: 'stream.ready', session: 'old' });
  return { stream, events, closed, statuses, socket: Socket.all[0] };
}
test('Temporary send congestion preserves every audio byte in order', async () => {
  const { stream, socket, closed } = setup();
  try {
    socket.bufferedAmount = 90000;
    const expected = [];
    for (let i = 0; i < 6; i++) { const block = new Uint8Array(16000).fill(i); expected.push(block); stream.push(block); }
    stream.pump(); assert.equal(stream.ready, true); assert.equal(stream.bytes, 96000); assert.deepEqual(closed, []);
    socket.bufferedAmount = 0; stream.pump(); assert.equal(stream.bytes, 0);
    assert.deepEqual(Buffer.concat(socket.sent), Buffer.concat(expected));
  } finally { await stream.stop(); }
});
test('A sustained backlog resets only the server session and ignores late events', async () => {
  const { stream, socket, closed, events } = setup();
  try {
    stream.push(new Uint8Array(300001));
    await wait(360);
    assert.deepEqual(closed, ['old']); assert.equal(stream.bytes, 0); assert.equal(socket.readyState, 3);
    assert.equal(Socket.all.length, 2); Socket.all[1].message({ event: 'stream.ready', session: 'new' });
    socket.message({ event: 'turn.accept', text: 'stale old audio' });
    Socket.all[1].message({ event: 'turn.accept', text: 'new audio' });
    assert.deepEqual(events.map((r) => r.text), ['new audio']);
  } finally { await stream.stop(); }
});
test('Pause/stop cancels automatic reconnect and never buffers paused audio', async () => {
  const { stream, socket } = setup();
  socket.close(); await stream.stop(); stream.push(new Uint8Array(64000)); await wait(360);
  assert.equal(Socket.all.length, 1); assert.equal(stream.bytes, 0); assert.equal(stream.active, false);
});
