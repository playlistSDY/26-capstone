const $ = (id) => document.getElementById(id);
const supportsSerial = Boolean(navigator.serial?.requestPort);
const state = { authenticated: false, running: false, connecting: false, stopping: false, port: null, reader: null, session: null, chunks: [], bytes: 0, generation: 0, controller: null, logs: [], bubbles: [] };
const labels = { started: '서버 준비', ready: '마이크 수신', speech_started: '말소리 감지', audio_segment: '구간 완료', recognizing: 'STT 시작', transcript: '인식 후보', filter_started: '문맥 확인', 'turn.accept': '문장 확정', 'turn.hold': '추가 발화 확인', 'turn.wait': '이어서 듣기', 'turn.ignore': '주변 대화', 'turn.clarify': '확인 필요', stt_error: 'STT 오류', filter_error: '판단 오류', audio_gap: '입력 끊김', audio_rejected: '비음성 제외', busy: '처리 지연' };
const seconds = (v) => typeof v === 'number' ? `${v.toFixed(2)}초` : '—';
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function log(type, text) {
  state.logs.push({ type, text, time: new Date().toLocaleTimeString('ko-KR', { hour12: false }) });
  if (state.logs.length > 100) state.logs.shift();
  $('log-count').textContent = state.logs.length;
  $('logs').replaceChildren(...state.logs.slice().reverse().map((r) => { const row = node('div'); row.append(node('time', r.time), node('strong', labels[r.type] || r.type), node('p', r.text || '')); return row; }));
}
function controls() {
  $('connect').disabled = !state.authenticated || !supportsSerial || state.connecting || state.stopping;
  $('connect').hidden = state.running;
  $('disconnect').hidden = !state.running;
  $('disconnect').disabled = state.stopping;
  $('connect').textContent = state.connecting ? '마이크와 서버 연결 중…' : 'ESP32 마이크 연결';
  $('device-light').classList.toggle('on', state.running);
  $('device-state').textContent = state.running ? '마이크 · 서버 연결됨' : state.connecting ? '연결 준비 중' : '마이크 연결 전';
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
  if (row.event === 'meter') { $('level').style.width = `${Math.min(100, Math.max(0, row.probability || 0) * 100)}%`; return; }
  if (row.event === 'level') return;
  log(row.event, row.text || row.message);
  switch (row.event) {
    case 'ready': $('stage').textContent = '듣고 있어요. 평소 목소리로 말씀하세요.'; break;
    case 'speech_started': $('stage').textContent = '말씀을 듣고 있어요.'; break;
    case 'recognizing': $('stage').textContent = '서버에서 음성을 글자로 바꾸고 있어요.'; break;
    case 'transcript': $('candidate').textContent = row.text || '(인식된 말 없음)'; $('stage').textContent = '문맥과 이어지는 말을 확인하고 있어요.'; break;
    case 'turn.hold': case 'turn.wait': $('stage').textContent = '이어서 말씀하셔도 괜찮아요.'; break;
    case 'turn.accept': {
      state.bubbles.push(row); if (state.bubbles.length > 24) state.bubbles.shift();
      $('messages').replaceChildren(...state.bubbles.map((r) => { const bubble = node('article', undefined, 'bubble'); bubble.append(node('p', r.text), node('small', `서버 처리 · STT 이후 ${seconds(r.after_stt_seconds)}`)); return bubble; }));
      $('messages').scrollTop = $('messages').scrollHeight;
      $('candidate').textContent = row.text; $('timing').textContent = `말이 끝난 뒤 ${seconds(row.from_speech_end_seconds)}`;
      $('stage').textContent = '전달할 말을 담았어요. 계속 말씀하세요.'; break;
    }
    case 'turn.ignore': $('stage').textContent = '주변 대화로 판단했어요. 다시 말씀하세요.'; break;
    case 'turn.clarify': case 'stt_error': case 'filter_error': $('stage').textContent = '이번 말을 전달하지 못했어요. 다시 말씀해 주세요.'; break;
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
        state.chunks.push(value); state.bytes += value.length;
        if (state.bytes > 48000) throw new Error('음성 전송이 밀렸어요. 인터넷 연결을 확인하고 다시 연결해 주세요.');
      }
    }
  } catch (error) { if (generation === state.generation && !state.stopping) failure = error.message || 'USB 입력을 읽을 수 없어요.'; }
  finally { reader.releaseLock(); }
  if (failure) await dispose(failure, true);
}
function takeAudio() {
  const result = new Uint8Array(Math.min(32768, state.bytes)); let offset = 0;
  while (offset < result.length) {
    const head = state.chunks[0], count = Math.min(head.length, result.length - offset);
    result.set(head.subarray(0, count), offset); offset += count;
    if (count === head.length) state.chunks.shift(); else state.chunks[0] = head.subarray(count);
  }
  state.bytes -= result.length; return result;
}
async function upload(generation) {
  let sequence = 0;
  try {
    while (state.running && generation === state.generation) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!state.running || generation !== state.generation) break;
      if (!state.bytes) continue;
      const started = performance.now();
      const response = await api(`voice/session/${state.session}/audio`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Audio-Sequence': String(sequence++) }, body: takeAudio() });
      await response.json();
      if (performance.now() - started > 800) throw new Error('음성 전송이 지연됐어요. 인터넷 연결을 확인하고 다시 연결해 주세요.');
    }
  } catch (error) { if (generation === state.generation && !state.stopping) await dispose(error.message || '서버 전송이 끊겼어요.', true); }
}
async function results(response, generation) {
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  try {
    while (generation === state.generation) {
      const { value, done } = await reader.read();
      if (done) { if (!state.stopping) throw new Error('서버 결과 연결이 끊겼어요.'); break; }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 65536) throw new Error('서버 응답을 확인할 수 없어요.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim() && generation === state.generation) apply(JSON.parse(line));
      }
    }
  } catch (error) { if (generation === state.generation && !state.stopping) await dispose(error.message || '결과 수신이 끊겼어요.', true); }
  finally { reader.releaseLock(); }
}
async function dispose(message = '연결을 해제했어요. 마이크 음성 전송을 멈췄어요.', error = false) {
  if (state.stopping) return;
  state.stopping = true; state.generation++; state.running = false; state.connecting = false; controls();
  const session = state.session, port = state.port, reader = state.reader;
  state.session = null; state.port = null; state.reader = null; state.chunks = []; state.bytes = 0;
  state.controller?.abort(); state.controller = null;
  if (reader) { try { await reader.cancel(); } catch {} }
  if (port) { try { await port.close(); } catch {} }
  if (session) { try { await api(`voice/session/${session}`, { method: 'DELETE', keepalive: true, signal: AbortSignal.timeout(2500) }); } catch {} }
  state.stopping = false; $('level').style.width = '0%'; $('stage').textContent = '연결을 기다리고 있어요'; notice(message, error); log(error ? '연결 오류' : '연결 해제', message); controls();
}
async function connect() {
  if (state.running || state.connecting || !state.authenticated) return;
  state.connecting = true; controls(); const generation = ++state.generation;
  try {
    const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x303a }] });
    state.port = port;
    await port.open({ baudRate: 921600, bufferSize: 65536, flowControl: 'none' });
    await port.setSignals({ dataTerminalReady: true, requestToSend: false });
    state.reader = port.readable.getReader(); void readUSB(generation);
    notice('마이크를 찾았어요. 음성 처리 서버를 연결하고 있어요.');
    const session = await (await api('voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    if (generation !== state.generation) { await api(`voice/session/${session.session}`, { method: 'DELETE' }); return; }
    state.session = session.session; state.controller = new AbortController();
    const response = await api(`voice/session/${state.session}/events`, { signal: state.controller.signal });
    if (generation !== state.generation) { await dispose(); return; }
    state.running = true; state.connecting = false; state.chunks = []; state.bytes = 0;
    controls(); notice('연결됐어요. 평소 목소리로 자유롭게 말씀해 주세요.'); log('연결 완료', 'ESP32 USB → 서버 음성 처리 → 이 화면으로 결과 수신');
    void results(response, generation); void upload(generation);
  } catch (error) {
    const cancelled = error.name === 'NotFoundError';
    await dispose(cancelled ? '장치 선택을 취소했어요. 준비되면 다시 연결하세요.' : error.message || '장치를 연결할 수 없어요. 시리얼 모니터를 종료하고 다시 연결해 주세요.', !cancelled);
  }
}
async function authenticate(access) {
  const response = await api('auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access }) });
  await response.json(); state.authenticated = true;
  $('invitation').hidden = true; $('server-state').textContent = '데모 접속 준비됨'; $('server-state').classList.add('ready');
  notice('USB 케이블을 연결하고 마이크 연결 버튼을 눌러 주세요.'); controls();
}
$('connect').addEventListener('click', connect);
$('disconnect').addEventListener('click', () => void dispose());
$('unlock').addEventListener('click', async () => { try { await authenticate($('access').value.trim()); $('access').value = ''; } catch (error) { notice(error.message, true); } });
$('clear').addEventListener('click', () => { state.bubbles = []; $('messages').replaceChildren(node('div', '다음에 전달할 말이 여기에 나타나요.', 'empty')); $('candidate').textContent = '화면을 비웠어요. 현재 연결과 수음은 유지돼요.'; });
$('log-toggle').addEventListener('click', () => { const open = $('logs').hidden; $('logs').hidden = !open; $('log-toggle').setAttribute('aria-expanded', String(open)); $('log-toggle').textContent = open ? '접기' : '자세히 보기'; });
for (const id of ['installer', 'package']) $(id).addEventListener('click', (event) => { if (!state.authenticated) { event.preventDefault(); notice('초대 링크로 접속한 뒤 내려받아 주세요.', true); } else if (state.running) { event.preventDefault(); notice('웹에서 수음을 먼저 중지한 뒤 설치형을 실행해 주세요.'); } else if (id === 'installer') { notice('내려받은 SWitch-Voice-Setup.cmd를 10분 안에 실행하세요. 설치 후 테스트 화면이 열려요.'); } });
addEventListener('beforeunload', () => { if (state.session) void fetch(new URL(`./api/voice/session/${state.session}`, location.href), { method: 'DELETE', credentials: 'same-origin', keepalive: true }); });
addEventListener('hashchange', async () => {
  const access = new URLSearchParams(location.hash.slice(1)).get('access');
  if (!access) return;
  history.replaceState(null, '', location.pathname);
  try { await authenticate(access); } catch (error) { notice(error.message, true); }
});
if (supportsSerial) navigator.serial.addEventListener('disconnect', () => { if (state.running || state.connecting) void dispose('마이크가 PC에서 분리됐어요. 다시 꽂고 연결해 주세요.', true); });
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
}
void initialize();
