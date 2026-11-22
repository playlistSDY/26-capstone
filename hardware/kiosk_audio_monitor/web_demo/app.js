import { AudioStream } from './audio_stream.js';
import { DebugView } from './debug_view.js';

const $ = (id) => document.getElementById(id);
const supportsSerial = Boolean(navigator.serial?.requestPort);
const prefKey = `switch.voice.${location.pathname}`;
function preference(name, fallback) { try { return JSON.parse(localStorage.getItem(`${prefKey}.${name}`)) ?? fallback; } catch { return fallback; } }
function remember(name, value) { try { localStorage.setItem(`${prefKey}.${name}`, JSON.stringify(value)); } catch {} }
const state = { authenticated: false, running: false, connecting: false, stopping: false, paused: preference('paused', false), pausing: false, port: null, reader: null, session: null, stream: null, generation: 0, logs: [], bubbles: [] };
const view = new DebugView();
const seconds = (v) => typeof v === 'number' ? `${Math.round(v*1000)} ms` : '—';
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('connection-message').textContent = text; }
function step(name, status, description, time) { const el = document.querySelector(`[data-step="${name}"]`); el.className = `pipeline-step ${status}`; el.querySelector('.step-description').textContent = description; if (time !== undefined) el.querySelector('.step-time').textContent = seconds(time); }
function resetSteps(description) { for (const name of ['capture', 'stt', 'merge', 'filter']) step(name, '', name === 'capture' ? description : 'PENDING', null); }
function showSettings() { if (!$('connection-modal').open) $('connection-modal').showModal(); }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function log(type, text) { view.handle({ event:type, message:text, time:Date.now()/1000 }); }
function controls() {
  $('connect').disabled = !state.authenticated || !supportsSerial || state.connecting || state.stopping;
  $('connect').hidden = state.running;
  $('disconnect').hidden = !state.running;
  $('disconnect').disabled = state.stopping;
  $('connect').textContent = state.connecting ? 'CONNECTING…' : 'CONNECT ESP32';
  $('device-light').classList.toggle('on', state.running);
  $('device-state').textContent = state.running ? (state.paused ? 'USB CONNECTED / PAUSED' : 'USB CONNECTED') : 'DISCONNECTED';
  $('connection-status').textContent = state.running ? 'USB CONNECTED' : state.connecting ? 'CONNECTING' : 'MIC CONFIG';
  $('processing-toggle').disabled = !state.running || state.pausing || state.stopping;
  $('processing-toggle').textContent = state.pausing ? 'UPDATING…' : state.paused ? 'RESUME' : 'PAUSE';
  $('processing-toggle').classList.toggle('paused', state.paused);
  $('processing-state').textContent = !state.running ? 'IDLE' : state.paused ? 'PAUSE' : state.stream?.ready ? 'RUNNING' : 'RECONNECTING';
  $('live-label').textContent = state.running && !state.paused ? 'LIVE' : state.paused ? 'PAUSED' : 'IDLE';
  $('live-dot').classList.toggle('on', state.running && !state.paused && Boolean(state.stream?.ready));
}
async function api(path, options = {}) {
  const response = await fetch(new URL(`./api/${path}`, location.href), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000), ...options });
  if (!response.ok) {
    const errors = { 401: 'Access expired. Reopen the invitation link.', 409: 'Session busy or interrupted. Close the other reader.', 410: 'Server session closed.', 503: 'Server unavailable. Retry shortly.' };
    throw new Error(errors[response.status] || `Server request failed. (${response.status})`);
  }
  return response;
}
function apply(row) {
  view.handle(row);
  const status = { ready:'LISTENING',speech_started:'CAPTURING',recognizing:'STT RUNNING',transcript:'BUFFERING',filter_started:'GATE RUNNING','turn.hold':'HOLD','turn.wait':'WAIT','turn.accept':'PASS','turn.ignore':'IGNORE','turn.clarify':'REVIEW',stt_error:'STT ERROR',filter_error:'GATE ERROR',audio_gap:'INPUT GAP',audio_resumed:'LISTENING' }[row.event];
  if (status) $('stage').textContent = status;
}
async function readUSB(generation) {
  const reader = state.reader;
  let failure;
  try {
    while (generation === state.generation) {
      const { value, done } = await reader.read();
      if (done) { if (generation === state.generation && !state.stopping) throw new Error('USB disconnected.'); break; }
      if (value?.length) view.observeUSB(value);
      if (value?.length && state.running) {
        state.stream?.push(value);
      }
    }
  } catch (error) { if (generation === state.generation && !state.stopping) failure = error.message || 'USB read failed.'; }
  finally { reader.releaseLock(); }
  if (failure) await dispose(failure, true);
}
async function dispose(message = 'USB disconnected. Transmission stopped.', error = false) {
  if (state.stopping) return;
  state.stopping = true; state.generation++; state.running = false; state.connecting = false; controls();
  const stream = state.stream, port = state.port, reader = state.reader;
  state.session = null; state.port = null; state.reader = null; state.stream = null; view.attachStream(null);
  if (reader) { try { await reader.cancel(); } catch {} }
  if (port) { try { await port.close(); } catch {} }
  await stream?.stop();
  state.stopping = false; $('level').style.width = '0%'; $('stage').textContent = 'USB IDLE'; resetSteps('USB IDLE'); notice(message, error); log(error ? 'ERROR' : 'DISCONNECT', message); controls();
}
function startProcessing(generation) {
  if (state.paused || !state.running) return;
  const url = new URL('./api/voice/stream', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.stream = new AudioStream(url, {
    onReady: (session) => { if (generation === state.generation && !state.paused) { state.session = session; view.setSession(session); log('STREAM_READY', 'USB → WSS → SERVER'); controls(); } },
    onEvent: (row) => { if (generation === state.generation && !state.stopping && !state.paused) apply(row); },
    onStatus: (status, message) => { if (generation !== state.generation || state.stopping || state.paused) return; notice(message); if (status !== 'ready') { $('stage').textContent = message; $('level').style.width = '0%'; resetSteps('SERVER RECONNECTING'); } controls(); },
    closeSession: async (session) => { if (state.session === session) state.session = null; await api(`voice/session/${session}`, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(2500) }); },
  });
  view.attachStream(state.stream); state.stream.start(); controls();
}
async function toggleProcessing() {
  if (!state.running || state.pausing) return;
  state.pausing = true; state.paused = !state.paused; remember('paused', state.paused); controls();
  if (state.paused) {
    const stream = state.stream; state.stream = null; view.attachStream(null); view.pause();
    $('level').style.width = '0%'; resetSteps('PAUSE'); $('stage').textContent = 'PROCESSING PAUSED'; notice('USB connected. No audio upload.');
    $('candidate-badge').textContent = 'PAUSED'; $('candidate-result').textContent = 'New audio only after resume.';
    await stream?.stop(); log('PAUSE', 'USB retained. Server processing stopped.');
  } else { resetSteps('CONNECTING SERVER'); log('RESUME', 'Starting a fresh server session.'); startProcessing(state.generation); }
  state.pausing = false; controls();
}
async function connect(grantedPort = null) {
  if (state.running || state.connecting || !state.authenticated) return;
  state.connecting = true; controls(); const generation = ++state.generation;
  try {
    const port = grantedPort || await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    state.port = port;
    await port.open({ baudRate: 921600, bufferSize: 65536, flowControl: 'none' });
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    state.reader = port.readable.getReader(); void readUSB(generation);
    if (generation !== state.generation) { await port.close(); return; }
    state.running = true; state.connecting = false;
    remember('auto', $('auto-connect').checked); remember('device', port.getInfo?.() || {});
    $('connection-modal').close();
    if (state.paused) { resetSteps('PAUSE'); $('stage').textContent = 'PROCESSING PAUSED'; notice('USB restored. Press RESUME to process audio.'); }
    else startProcessing(generation);
    controls();
  } catch (error) {
    const cancelled = error.name === 'NotFoundError';
    await dispose(cancelled ? 'Device selection cancelled.' : error.message || 'USB open failed. Close other serial readers.', !cancelled);
  }
}
async function autoConnect() {
  if (!state.authenticated || !supportsSerial || !preference('auto', true) || state.running || state.connecting || state.stopping) return;
  try {
    const ports = await navigator.serial.getPorts();
    const wanted = preference('device', {});
    const matches = ports.filter((port) => { const info = port.getInfo?.() || {}; return (info.usbVendorId === 0x303a || !info.usbVendorId) && (!wanted.usbProductId || info.usbProductId === wanted.usbProductId); });
    if (matches.length === 1) { log('AUTO_CONNECT', 'Reusing granted USB device.'); await connect(matches[0]); }
    else { notice(matches.length ? 'Multiple granted devices. Select one in MIC CONFIG.' : 'Waiting for granted USB device.'); if (!preference('device', null)) showSettings(); }
  } catch { notice('Auto-connect unavailable. Open MIC CONFIG.'); }
}
async function authenticate(access) {
  const response = await api('auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access }) });
  await response.json(); state.authenticated = true;
  $('invitation').hidden = true; $('server-state').textContent = 'AUTH OK'; $('server-state').classList.add('ready');
  notice('Open MIC CONFIG to connect a USB source.'); controls(); void autoConnect();
}
$('connection-open').addEventListener('click', showSettings);
$('connection-close').addEventListener('click', () => $('connection-modal').close());
$('connect').addEventListener('click', () => void connect());
$('disconnect').addEventListener('click', () => { remember('auto', false); $('auto-connect').checked = false; void dispose(); });
$('processing-toggle').addEventListener('click', () => void toggleProcessing());
$('auto-connect').checked = preference('auto', true);
$('auto-connect').addEventListener('change', () => remember('auto', $('auto-connect').checked));
$('unlock').addEventListener('click', async () => { try { await authenticate($('access').value.trim()); $('access').value = ''; } catch (error) { notice(error.message, true); } });
$('clear').addEventListener('click', () => view.clear());
$('clear-logs').addEventListener('click', () => view.clearLogs());
for (const id of ['installer', 'package']) $(id).addEventListener('click', (event) => { if (!state.authenticated) { event.preventDefault(); notice('Authentication required.', true); } else if (state.running) { event.preventDefault(); notice('Disconnect the web reader before running the helper.'); } else if (id === 'installer') { notice('Run SWitch-Voice-Setup.cmd within 10 minutes.'); } });
addEventListener('beforeunload', () => { if (state.session) void fetch(new URL(`./api/voice/session/${state.session}`, location.href), { method: 'DELETE', credentials: 'same-origin', keepalive: true }); });
addEventListener('hashchange', async () => {
  const access = new URLSearchParams(location.hash.slice(1)).get('access');
  if (!access) return;
  history.replaceState(null, '', location.pathname);
  try { await authenticate(access); } catch (error) { notice(error.message, true); }
});
if (supportsSerial) {
  navigator.serial.addEventListener('disconnect', (event) => { if ((event.target === state.port || event.port === state.port || !state.port?.readable) && (state.running || state.connecting)) void dispose('USB removed. Waiting for device reconnect.', true); });
  navigator.serial.addEventListener('connect', () => setTimeout(() => void autoConnect(), 700));
}
async function initialize() {
  if (!supportsSerial) $('browser-note').textContent = 'Web Serial unavailable. Use desktop Chrome/Edge or the native helper.';
  const access = new URLSearchParams(location.hash.slice(1)).get('access');
  if (access) history.replaceState(null, '', location.pathname);
  try {
    if (access) await authenticate(access);
    else { const current = await (await api('state')).json(); state.authenticated = current.authenticated; if (state.authenticated) { $('server-state').textContent = 'AUTH OK'; $('server-state').classList.add('ready'); notice('Open MIC CONFIG to connect a USB source.'); } }
  } catch (error) { notice(error.message, true); }
  if (!state.authenticated) { $('invitation').hidden = false; $('server-state').textContent = 'AUTH REQUIRED'; notice('Open an invitation link or enter the access key.'); }
  controls();
  if (!state.authenticated || !supportsSerial || !preference('auto', true)) showSettings();
  if (state.authenticated) void autoConnect();
}
void initialize();
