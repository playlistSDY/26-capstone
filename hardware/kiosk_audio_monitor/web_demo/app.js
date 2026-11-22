import { AudioStream } from './audio_stream.js';

const $ = (id) => document.getElementById(id);
const supportsSerial = Boolean(navigator.serial?.requestPort);
const prefKey = `switch.voice.${location.pathname}`;
function preference(name, fallback) { try { return JSON.parse(localStorage.getItem(`${prefKey}.${name}`)) ?? fallback; } catch { return fallback; } }
function remember(name, value) { try { localStorage.setItem(`${prefKey}.${name}`, JSON.stringify(value)); } catch {} }
const state = { authenticated: false, running: false, connecting: false, stopping: false, paused: preference('paused', false), pausing: false, port: null, reader: null, session: null, stream: null, generation: 0, logs: [], bubbles: [] };
const labels = { started: '서버 준비', ready: '마이크 수신', speech_started: '말소리 감지', audio_segment: '구간 완료', recognizing: 'STT 시작', transcript: '인식 후보', filter_started: '문맥 확인', 'turn.accept': '문장 확정', 'turn.hold': '추가 발화 확인', 'turn.wait': '이어서 듣기', 'turn.ignore': '주변 대화', 'turn.clarify': '확인 필요', stt_error: 'STT 오류', filter_error: '판단 오류', audio_gap: '입력 끊김', audio_rejected: '비음성 제외', busy: '처리 지연' };
const seconds = (v) => typeof v === 'number' ? `${v.toFixed(2)}초` : '—';
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('connection-message').textContent = text; }
function step(name, status, description, time) { const el = document.querySelector(`[data-step="${name}"]`); el.className = `pipeline-step ${status}`; el.querySelector('.step-description').textContent = description; if (time !== undefined) el.querySelector('.step-time').textContent = seconds(time); }
function resetSteps(description) { for (const name of ['capture', 'stt', 'merge', 'filter']) step(name, '', name === 'capture' ? description : '처리 대기', null); }
function showSettings() { if (!$('connection-modal').open) $('connection-modal').showModal(); }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function log(type, text) {
  state.logs.push({ type, text, time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) });
  if (state.logs.length > 100) state.logs.shift();
  $('log-count').textContent = state.logs.length;
  $('logs').replaceChildren(...state.logs.slice().reverse().map((r) => { const row = node('div', undefined, 'log-row'); const copy = node('div', undefined, 'log-content'); copy.append(node('b', labels[r.type] || r.type), node('p', r.text || '')); row.append(node('time', r.time, 'log-time'), copy); return row; }));
}
function controls() {
  $('connect').disabled = !state.authenticated || !supportsSerial || state.connecting || state.stopping;
  $('connect').hidden = state.running;
  $('disconnect').hidden = !state.running;
  $('disconnect').disabled = state.stopping;
  $('connect').textContent = state.connecting ? '마이크와 서버 연결 중…' : 'ESP32 마이크 연결';
  $('device-light').classList.toggle('on', state.running);
  $('device-state').textContent = state.running ? (state.paused ? '마이크 연결됨 · 음성 처리 일시정지' : '마이크 연결됨') : '마이크 연결 전';
  $('connection-status').textContent = state.running ? '마이크 연결됨' : state.connecting ? '연결 중' : '마이크 연결';
  $('processing-toggle').disabled = !state.running || state.pausing || state.stopping;
  $('processing-toggle').textContent = state.pausing ? '처리 변경 중…' : state.paused ? '음성 처리 재개' : '음성 처리 일시정지';
  $('processing-toggle').classList.toggle('paused', state.paused);
  $('processing-state').textContent = !state.running ? '음성 처리 대기' : state.paused ? '음성 처리 일시정지' : state.stream?.ready ? '음성 처리 중' : '서버 연결 중';
  $('live-label').textContent = state.running && !state.paused ? 'LIVE' : state.paused ? '일시정지' : '대기';
  $('live-dot').classList.toggle('on', state.running && !state.paused && Boolean(state.stream?.ready));
}
async function api(path, options = {}) {
  const response = await fetch(new URL(`./api/${path}`, location.href), { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000), ...options });
  if (!response.ok) {
    const errors = { 401: '초대 링크로 다시 접속해 주세요.', 409: '다른 수음기가 사용 중이거나 음성 전송이 끊겼어요. 기존 테스트를 종료하고 다시 연결해 주세요.', 410: '서버 연결이 종료됐어요. 다시 연결해 주세요.', 503: '서버가 아직 준비되지 않았어요. 잠시 후 다시 연결해 주세요.' };
    throw new Error(errors[response.status] || `서버에 연결하지 못했어요. (${response.status})`);
  }
  return response;
}
function apply(row) {
  if (row.event === 'meter') { $('level').style.width = `${Math.min(100, Math.max(0, row.probability || 0) * 100)}%`; $('rms').textContent = row.rms ?? '—'; $('noise').textContent = `${row.noise ?? '—'} / ${row.threshold ?? '—'}`; $('probability').textContent = typeof row.probability === 'number' ? row.probability.toFixed(2) : '—'; return; }
  if (row.event === 'level') { $('packet-errors').textContent = `${row.gaps ?? 0} / ${row.bad ?? 0}`; return; }
  log(row.event, row.text || row.message);
  switch (row.event) {
    case 'ready': step('capture', 'active', '말을 기다리는 중'); $('stage').textContent = '듣고 있어요. 평소 목소리로 말씀하세요.'; break;
    case 'speech_started': step('capture', 'active', '말소리를 수집하고 있어요', null); for (const name of ['stt','merge','filter']) step(name, '', '다음 음성 구간 대기', null); $('candidate-badge').textContent = '수음 중'; $('stage').textContent = '말씀을 듣고 있어요.'; break;
    case 'audio_segment': step('capture', 'done', '음성 구간을 받았어요', row.endpoint_seconds); break;
    case 'recognizing': step('stt', 'active', '음성을 글자로 바꾸는 중'); $('candidate-badge').textContent = 'STT 중'; $('stage').textContent = '서버에서 음성을 글자로 바꾸고 있어요.'; break;
    case 'transcript': step('stt', 'done', '음성 인식 완료', row.elapsed); step('merge', 'active', '이어서 말할 수 있어요'); $('candidate').textContent = row.text || '(인식된 말 없음)'; $('candidate-badge').textContent = '후보'; $('candidate-result').textContent = '아직 최종 확정 전의 인식 결과예요.'; $('stt-time').textContent = seconds(row.elapsed); $('stage').textContent = '문맥과 이어지는 말을 확인하고 있어요.'; break;
    case 'filter_started': step('filter', 'active', '주변 대화와 문맥을 확인'); break;
    case 'turn.hold': case 'turn.wait': step('filter', 'done', '의미 판단 완료', row.filter_seconds); step('merge', 'active', '추가 발화 확인'); $('candidate-badge').textContent = '이어서 듣기'; $('stage').textContent = '이어서 말씀하셔도 괜찮아요.'; break;
    case 'turn.accept': {
      state.bubbles.push(row); if (state.bubbles.length > 24) state.bubbles.shift();
      $('messages').replaceChildren(...state.bubbles.map((r) => { const bubble = node('article', undefined, 'message-bubble bubble'); bubble.append(node('p', r.text, 'message-text'), node('small', `서버 처리 · STT 이후 ${seconds(r.after_stt_seconds)}`)); return bubble; }));
      $('messages').scrollTop = $('messages').scrollHeight;
      $('candidate').textContent = row.text; $('timing').textContent = seconds(row.from_speech_end_seconds); $('stt-time').textContent = seconds(row.stt_seconds); $('filter-time').textContent = seconds(row.filter_seconds); $('after-stt').textContent = seconds(row.after_stt_seconds); $('route').textContent = row.usage?.route?.startsWith('local_') ? '서버 빠른 판별' : '의미 판단'; $('candidate-badge').textContent = '전달 준비'; $('candidate-result').textContent = '확정된 원문을 그대로 전달할 수 있어요.'; for (const name of ['capture','merge','filter']) step(name, 'done', '처리 완료', name === 'filter' ? row.filter_seconds : undefined);
      $('stage').textContent = '전달할 말을 담았어요. 계속 말씀하세요.'; break;
    }
    case 'turn.ignore': step('filter', 'done', '주변 대화로 판단', row.filter_seconds); $('candidate-badge').textContent = '주변 대화'; $('stage').textContent = '주변 대화로 판단했어요. 다시 말씀하세요.'; break;
    case 'turn.clarify': case 'stt_error': case 'filter_error': step('filter', 'warn', '확인 필요 · 전달 보류'); $('candidate-badge').textContent = '확인 필요'; $('stage').textContent = '이번 말을 전달하지 못했어요. 다시 말씀해 주세요.'; break;
    case 'remote.closed': throw new Error('서버 연결이 종료됐어요. 다시 연결해 주세요.');
  }
}
async function readUSB(generation) {
  const reader = state.reader;
  let failure;
  try {
    while (generation === state.generation) {
      const { value, done } = await reader.read();
      if (done) { if (generation === state.generation && !state.stopping) throw new Error('마이크 USB 연결이 끊겼어요.'); break; }
      if (value?.length && state.running) {
        state.stream?.push(value);
      }
    }
  } catch (error) { if (generation === state.generation && !state.stopping) failure = error.message || 'USB 입력을 읽을 수 없어요.'; }
  finally { reader.releaseLock(); }
  if (failure) await dispose(failure, true);
}
async function dispose(message = '연결을 해제했어요. 마이크 음성 전송을 멈췄어요.', error = false) {
  if (state.stopping) return;
  state.stopping = true; state.generation++; state.running = false; state.connecting = false; controls();
  const stream = state.stream, port = state.port, reader = state.reader;
  state.session = null; state.port = null; state.reader = null; state.stream = null;
  if (reader) { try { await reader.cancel(); } catch {} }
  if (port) { try { await port.close(); } catch {} }
  await stream?.stop();
  state.stopping = false; $('level').style.width = '0%'; $('stage').textContent = '마이크 연결 대기'; resetSteps('마이크 연결 대기'); notice(message, error); log(error ? '연결 오류' : '연결 해제', message); controls();
}
function startProcessing(generation) {
  if (state.paused || !state.running) return;
  const url = new URL('./api/voice/stream', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.stream = new AudioStream(url, {
    onReady: (session) => { if (generation === state.generation && !state.paused) { state.session = session; log('연결 완료', 'USB 마이크 → 지속 음성 연결 → 서버 인식'); controls(); } },
    onEvent: (row) => { if (generation === state.generation && !state.stopping && !state.paused) apply(row); },
    onStatus: (status, message) => { if (generation !== state.generation || state.stopping || state.paused) return; notice(message); if (status !== 'ready') { $('stage').textContent = message; $('level').style.width = '0%'; resetSteps('서버 연결 확인 중'); } controls(); },
    closeSession: async (session) => { if (state.session === session) state.session = null; await api(`voice/session/${session}`, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(2500) }); },
  });
  state.stream.start(); controls();
}
async function toggleProcessing() {
  if (!state.running || state.pausing) return;
  state.pausing = true; state.paused = !state.paused; remember('paused', state.paused); controls();
  if (state.paused) {
    const stream = state.stream; state.stream = null;
    $('level').style.width = '0%'; resetSteps('음성 처리 일시정지'); $('stage').textContent = '음성 처리를 잠시 멈췄어요.'; notice('USB 마이크는 연결되어 있고 음성은 서버에 보내지 않아요.');
    $('candidate-badge').textContent = '일시정지'; $('candidate-result').textContent = '재개한 시점부터 새로운 음성을 처리해요.';
    await stream?.stop(); log('처리 일시정지', '마이크 연결 유지 · 서버 전송과 처리 중지');
  } else { resetSteps('서버 연결 준비'); log('처리 재개', '이전 음성 없이 새 수음을 시작해요.'); startProcessing(state.generation); }
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
    if (state.paused) { resetSteps('음성 처리 일시정지'); $('stage').textContent = '음성 처리를 잠시 멈췄어요.'; notice('마이크 연결을 복구했어요. 음성 처리 재개 버튼을 누르면 수음을 시작해요.'); }
    else startProcessing(generation);
    controls();
  } catch (error) {
    const cancelled = error.name === 'NotFoundError';
    await dispose(cancelled ? '장치 선택을 취소했어요. 준비되면 다시 연결하세요.' : error.message || '장치를 연결할 수 없어요. 시리얼 모니터를 종료하고 다시 연결해 주세요.', !cancelled);
  }
}
async function autoConnect() {
  if (!state.authenticated || !supportsSerial || !preference('auto', true) || state.running || state.connecting || state.stopping) return;
  try {
    const ports = await navigator.serial.getPorts();
    const wanted = preference('device', {});
    const matches = ports.filter((port) => { const info = port.getInfo?.() || {}; return (info.usbVendorId === 0x303a || !info.usbVendorId) && (!wanted.usbProductId || info.usbProductId === wanted.usbProductId); });
    if (matches.length === 1) { log('자동 연결', '이전에 허용한 USB 마이크를 다시 연결해요.'); await connect(matches[0]); }
    else { notice(matches.length ? '허용된 마이크가 여러 대예요. 연결 설정에서 사용할 장치를 선택하세요.' : '이전에 허용한 마이크를 기다리고 있어요. USB를 꽂으면 자동으로 연결해요.'); if (!preference('device', null)) showSettings(); }
  } catch { notice('자동 연결을 확인하지 못했어요. 상단 마이크 연결 설정에서 다시 선택해 주세요.'); }
}
async function authenticate(access) {
  const response = await api('auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access }) });
  await response.json(); state.authenticated = true;
  $('invitation').hidden = true; $('server-state').textContent = '데모 접속 준비됨'; $('server-state').classList.add('ready');
  notice('상단 연결 설정에서 마이크를 연결해 주세요.'); controls(); void autoConnect();
}
$('connection-open').addEventListener('click', showSettings);
$('connection-close').addEventListener('click', () => $('connection-modal').close());
$('connect').addEventListener('click', () => void connect());
$('disconnect').addEventListener('click', () => { remember('auto', false); $('auto-connect').checked = false; void dispose(); });
$('processing-toggle').addEventListener('click', () => void toggleProcessing());
$('auto-connect').checked = preference('auto', true);
$('auto-connect').addEventListener('change', () => remember('auto', $('auto-connect').checked));
$('unlock').addEventListener('click', async () => { try { await authenticate($('access').value.trim()); $('access').value = ''; } catch (error) { notice(error.message, true); } });
$('clear').addEventListener('click', () => { state.bubbles = []; $('messages').replaceChildren(node('div', '다음에 전달할 말이 여기에 나타나요.', 'empty')); $('candidate').textContent = '화면을 비웠어요. 현재 연결과 수음은 유지돼요.'; });
$('clear-logs').addEventListener('click', () => { state.logs = []; $('logs').replaceChildren(node('p', '다음 처리부터 기록이 쌓여요.', 'logs-empty')); $('log-count').textContent = '0'; });
for (const id of ['installer', 'package']) $(id).addEventListener('click', (event) => { if (!state.authenticated) { event.preventDefault(); notice('초대 링크로 접속한 뒤 내려받아 주세요.', true); } else if (state.running) { event.preventDefault(); notice('웹에서 수음을 먼저 중지한 뒤 설치형을 실행해 주세요.'); } else if (id === 'installer') { notice('내려받은 SWitch-Voice-Setup.cmd를 10분 안에 실행하세요. 설치 후 테스트 화면이 열려요.'); } });
addEventListener('beforeunload', () => { if (state.session) void fetch(new URL(`./api/voice/session/${state.session}`, location.href), { method: 'DELETE', credentials: 'same-origin', keepalive: true }); });
addEventListener('hashchange', async () => {
  const access = new URLSearchParams(location.hash.slice(1)).get('access');
  if (!access) return;
  history.replaceState(null, '', location.pathname);
  try { await authenticate(access); } catch (error) { notice(error.message, true); }
});
if (supportsSerial) {
  navigator.serial.addEventListener('disconnect', (event) => { if ((event.target === state.port || event.port === state.port || !state.port?.readable) && (state.running || state.connecting)) void dispose('마이크가 PC에서 분리됐어요. 다시 꽂으면 허용된 장치를 자동으로 연결해요.', true); });
  navigator.serial.addEventListener('connect', () => setTimeout(() => void autoConnect(), 700));
}
async function initialize() {
  if (!supportsSerial) $('browser-note').textContent = '이 브라우저는 USB 직접 연결을 지원하지 않아요. 데스크톱 Chrome·Edge에서 열거나 연결 도우미를 사용해 주세요.';
  const access = new URLSearchParams(location.hash.slice(1)).get('access');
  if (access) history.replaceState(null, '', location.pathname);
  try {
    if (access) await authenticate(access);
    else { const current = await (await api('state')).json(); state.authenticated = current.authenticated; if (state.authenticated) { $('server-state').textContent = '데모 접속 준비됨'; $('server-state').classList.add('ready'); notice('USB 케이블을 연결하고 마이크 연결 버튼을 눌러 주세요.'); } }
  } catch (error) { notice(error.message, true); }
  if (!state.authenticated) { $('invitation').hidden = false; $('server-state').textContent = '초대 링크로 접속해 주세요'; notice('전달받은 초대 링크로 접속하거나 테스트 접속 키를 입력해 주세요.'); }
  controls();
  if (!state.authenticated || !supportsSerial || !preference('auto', true)) showSettings();
  if (state.authenticated) void autoConnect();
}
void initialize();
