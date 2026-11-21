const $ = (id) => document.getElementById(id);
const model = { token: '', cursor: 0, running: false, history: [], logs: [], detailed: false, connected: false, meters: Array(44).fill(0) };
const labels = { 'worker.starting': '연결 시작', started: '수음 시작', ready: 'USB 연결됨', speech_started: '말소리 감지', audio_segment: '음성 구간 완료', recognizing: 'STT 시작', transcript: '인식 후보', filter_started: '전달할 말 판단', 'turn.accept': '문장 확정', 'turn.ignore': '무관한 말 · 무시', 'turn.wait': '이어지는 말 대기', 'turn.hold': '추가 발화 확인', 'turn.clarify': '확인 필요 · 보류', decision_stale: '새 발화 · 다시 판단', audio_rejected: '비음성 후보 제외', audio_gap: 'USB 입력 끊김', stt_error: 'STT 오류', filter_error: '의미 필터 오류', stopped: '수음 중지', 'worker.exited': '수음기 종료', level: '마이크 수치', busy: '처리 대기 초과', 'worker.log': '수음기 메시지' };
const reasons = { ready: '키오스크에 전달할 말로 확인했어요.', unrelated_speech: '의논이나 주문과 관계없는 말로 판단했어요.', needs_more_words: '말이 이어질 수 있어 조금 더 기다려요.', unclear_target: '누구에게 한 말인지 아직 분명하지 않아요.', mixed_or_ambiguous: '여러 의도가 섞여 자동 전달을 보류했어요.', continuation_window: '의미 판단은 끝났고 추가 발화만 확인해요.', incomplete_timeout: '충분히 기다렸지만 문장을 확정하지 못했어요.', audio_or_transcription_incomplete: '입력이 끊겨 일부 단어만 전달하지 않았어요.', filter_unavailable: '필터 응답을 확인하지 못해 전달하지 않았어요.', empty_transcript: '인식된 문장이 없어요.', filter_disabled: '비교용으로 필터가 꺼져 있어요.' };
reasons.context_for_agent = '단답·참조·정정의 뜻은 에이전트가 문맥으로 이해하도록 원문을 넘겨요.';
reasons.partial_for_agent = '더 이어지는 말이 없어 지금까지 들은 원문을 에이전트에게 넘겨요.';
function routeName(row) { return row.usage?.route === 'local_explicit_order' ? '로컬 빠른 판별' : row.usage?.route === 'local_conversation' ? '단답 · 문맥 전달' : row.usage?.model ? '의미 모델' : '문맥 확인'; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function duration(seconds) { return typeof seconds !== 'number' || !Number.isFinite(seconds) ? '—' : seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(2)}s`; }
function clock(seconds) { return new Date(seconds * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }); }
function step(name, status, description, time) { const node = document.querySelector(`[data-step="${name}"]`); node.className = `pipeline-step ${status}`; node.querySelector('.step-description').textContent = description; if (time !== undefined) node.querySelector('.step-time').textContent = duration(time); }
function caption(title, sub) { $('listening-state').textContent = title; if (sub) $('stage-caption').textContent = sub; }
function controls() { $('record-button').disabled = !model.connected; $('record-label').textContent = model.running ? '수음 중지' : '수음 시작'; $('record-icon').textContent = model.running ? '■' : '▶'; $('record-button').classList.toggle('stopped', !model.running); $('live-dot').classList.toggle('on', model.running); }
function connected(value) { model.connected = value; $('connection').className = `connection ${value ? 'connected' : ''}`; $('connection').replaceChildren(el('i'), document.createTextNode(value ? '로컬 연결됨' : '다시 연결 중')); controls(); }
function timing(row) { $('stt-time').textContent = duration(row.stt_seconds); $('filter-time').textContent = duration(row.filter_seconds); $('after-stt').textContent = duration(row.after_stt_seconds); $('total-time').textContent = duration(row.from_speech_end_seconds); $('route').textContent = routeName(row); }
function bubbles() {
  if (!model.history.length) return;
  const nodes = model.history.slice(-20).map((row) => {
    const node = el('article', 'message-bubble'); node.dataset.eventId = row.id;
    const top = el('div', 'message-top'); top.append(el('strong', '', '나 · 전달할 말'), el('time', '', clock(row.time)));
    const bottom = el('div', 'message-bottom');
    bottom.append(el('span', 'route-tag', routeName(row)), el('span', '', `STT 이후 ${duration(row.after_stt_seconds)}`));
    const copy = el('button', 'copy-button', '문장 복사'); copy.setAttribute('aria-label', '전달 문장 복사'); copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(row.text); copy.textContent = '복사했어요'; } catch { copy.textContent = '복사하지 못했어요'; } }); bottom.append(copy);
    node.append(top, el('p', 'message-text', row.text), bottom); return node;
  });
  $('bubbles').replaceChildren(...nodes); $('bubbles').scrollTop = $('bubbles').scrollHeight;
}
function renderLogs() {
  const rows = model.logs.filter((r) => model.detailed || r.event !== 'level').slice(-140).reverse();
  $('log-count').textContent = rows.length;
  if (!rows.length) { $('logs').replaceChildren(el('p', 'logs-empty', '처리가 시작되면 로그가 쌓여요.')); return; }
  $('logs').replaceChildren(...rows.map((row) => {
    const node = el('div', `log-row ${row.event === 'turn.accept' ? 'accept' : /error|clarify|gap/.test(row.event) ? 'warn' : ''}`);
    node.append(el('time', 'log-time', clock(row.time)));
    const body = el('div', 'log-content'); body.append(el('b', '', labels[row.event] || row.event));
    const text = row.text || reasons[row.reason] || (row.message || '').replace(/\s+/g, ' ');
    if (text) body.append(document.createTextNode(text.slice(0, 180)));
    if (row.filter_seconds !== undefined && row.filter_seconds !== null) body.append(el('div', '', `의미 판단 ${duration(row.filter_seconds)}`));
    node.append(body); return node;
  }));
}
function meter(row) {
  const value = Math.min(1, Math.log10(1 + (row.rms || 0)) / Math.log10(6000));
  model.meters.push(value); model.meters.shift();
  [...$('wave').children].forEach((bar, i) => { bar.style.height = `${3 + model.meters[i] * 23}px`; });
  $('avatar-wrap').classList.toggle('speaking', Boolean(row.active));
  $('rms').textContent = String(row.rms ?? '—'); $('noise').textContent = `${row.noise ?? '—'} / ${row.threshold ?? '—'}`;
  $('probability').textContent = typeof row.probability === 'number' ? row.probability.toFixed(2) : '—';
}
function apply(row, replay = false) {
  if (!replay && row.id <= model.cursor) return;
  model.cursor = Math.max(model.cursor, row.id || 0);
  if (row.event === 'meter') { meter(row); return; }
  if (row.event === 'level') { $('packet-errors').textContent = `${row.gaps ?? 0} / ${row.bad ?? 0}`; }
  model.logs.push(row); if (model.logs.length > 400) model.logs.shift();
  if (!replay) renderLogs();
  switch (row.event) {
    case 'worker.starting': model.running = true; caption('마이크를 연결하고 있어요'); break;
    case 'started': model.running = true; break;
    case 'ready': step('capture', 'active', '말을 기다리는 중'); caption('듣고 있어요', '평소 목소리로 말씀해 주세요.'); break;
    case 'speech_started':
      step('capture', 'active', '말소리를 수집하고 있어요', null); step('stt', '', '다음 음성 구간 대기', null); step('merge', '', '발화가 이어지는지 확인', null); step('filter', '', '판단 대기', null);
      caption('말씀을 듣고 있어요', '단어나 짧은 대답도 그대로 전달해요.'); $('candidate-badge').textContent = '수음 중'; break;
    case 'audio_segment': step('capture', 'done', '음성 구간을 받았어요', row.endpoint_seconds); break;
    case 'recognizing': step('stt', 'active', '음성을 글자로 바꾸는 중'); $('candidate-badge').textContent = 'STT 중'; caption('말을 글자로 바꾸고 있어요'); break;
    case 'transcript':
      step('stt', 'done', '음성 인식 완료', row.elapsed); step('merge', 'active', '이어서 말할 수 있어요'); $('candidate').textContent = row.text || '(인식된 말 없음)'; $('candidate-badge').textContent = '후보'; $('candidate-result').textContent = '최종 확정 전의 인식 결과예요.'; $('stt-time').textContent = duration(row.elapsed); caption('전달할 말을 정리하고 있어요', '추가 말이 들어오면 같은 문장으로 이어서 판단해요.'); break;
    case 'filter_started': step('filter', 'active', '명백한 주변 대화만 확인'); $('candidate').textContent = row.text; $('candidate-badge').textContent = '판단 중'; break;
    case 'turn.hold': $('candidate').textContent = row.text; step('filter', 'done', '의미 판단 완료', row.filter_seconds); step('merge', 'active', '추가 발화만 확인 중'); $('candidate-result').textContent = reasons[row.reason]; break;
    case 'turn.wait': step('filter', 'done', '아직 문장이 덜 끝났어요', row.filter_seconds); step('merge', 'active', '이어서 말씀해 주세요'); $('candidate-badge').textContent = '대기'; $('candidate-result').textContent = reasons[row.reason] || row.reason; caption('이어서 말씀해 주세요', '인식한 조각을 버리지 않고 기다리고 있어요.'); break;
    case 'turn.accept':
      $('candidate').textContent = row.text; step('capture', 'done', '음성 구간 수집 완료');
      if (!model.history.some((r) => r.id === row.id)) model.history.push(row);
      if (model.history.length > 64) model.history.shift();
      if (!replay) bubbles(); timing(row); step('merge', 'done', '발화 정리 완료'); step('filter', 'done', row.usage?.route?.startsWith('local_') ? routeName(row) : '대화 원문을 그대로 전달', row.filter_seconds); $('candidate-badge').textContent = '전달 준비'; $('candidate-result').textContent = reasons[row.reason] || reasons.ready; caption('전달할 말을 담았어요', '이어서 말씀하시면 다음 말도 문맥으로 이어가요.'); break;
    case 'turn.ignore': case 'turn.clarify':
      $('candidate').textContent = row.text || '(인식된 말 없음)'; step('capture', 'done', '음성 구간 수집 완료');
      timing(row); step('merge', 'done', '발화 수집 완료'); step('filter', row.event === 'turn.clarify' ? 'warn' : 'done', row.event === 'turn.clarify' ? '확인 필요 · 전달 보류' : '주문과 무관한 말', row.filter_seconds); $('candidate-badge').textContent = row.event === 'turn.clarify' ? '보류' : '무시'; $('candidate-result').textContent = reasons[row.reason] || row.reason; caption('다음 말씀을 기다리고 있어요', '확정한 문장만 왼쪽 말풍선에 남아요.'); break;
    case 'decision_stale': step('filter', '', '새 발화가 들어와 다시 판단'); break;
    case 'audio_gap': case 'stt_error': case 'filter_error': case 'busy': step('filter', 'warn', labels[row.event]); $('candidate-result').textContent = row.message; caption('입력을 확인하고 있어요', '불완전한 문장은 자동으로 전달하지 않아요.'); break;
    case 'stopped': case 'worker.exited': model.running = false; $('avatar-wrap').classList.remove('speaking'); step('capture', '', row.code ? '연결을 확인해 주세요' : '수음이 중지됐어요'); caption('마이크가 쉬고 있어요', '오른쪽 위에서 수음을 다시 시작할 수 있어요.'); break;
  }
  controls();
}
async function control(path) {
  $('record-button').disabled = true;
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voice-Token': model.token }, body: '{}' });
    if (!response.ok) throw Error('수음 상태를 바꾸지 못했어요.');
    model.running = (await response.json()).running; $('error-banner').hidden = true;
  } catch (error) { $('error-banner').textContent = error.message; $('error-banner').hidden = false; }
  controls();
}
async function init() {
  $('wave').replaceChildren(...model.meters.map(() => el('span')));
  const response = await fetch('/api/state'); if (!response.ok) throw Error('로컬 수음기에 연결하지 못했어요.');
  const state = await response.json(); model.token = state.token; model.running = state.running; model.history = state.accepted || [];
  if (state.running) { step('capture', 'active', '말을 기다리는 중'); caption('듣고 있어요', '평소 목소리로 말씀해 주세요.'); }
  if (model.history.length) timing(model.history.at(-1));
  // Replaying minutes of 8Hz meters causes needless layout work on slow PCs.
  const meaningful = state.events.filter(r => r.event !== 'meter' && r.event !== 'level').slice(-180);
  for (const row of meaningful) apply(row, true);
  for (const row of state.events.filter(r => r.event === 'meter').slice(-44)) apply(row, true);
  const lastLevel = state.events.findLast(r => r.event === 'level'); if (lastLevel) apply(lastLevel, true);
  model.cursor = state.cursor; model.running = state.running; bubbles(); renderLogs(); connected(true);
  if (!state.running) { $('avatar-wrap').classList.remove('speaking'); caption('마이크가 쉬고 있어요', '오른쪽 위에서 수음을 시작할 수 있어요.'); }
  const stream = new EventSource(`/api/events?after=${model.cursor}`);
  stream.onmessage = (event) => { connected(true); apply(JSON.parse(event.data)); };
  stream.onerror = () => connected(false);
}
$('record-button').addEventListener('click', () => control(model.running ? '/api/stop' : '/api/start'));
$('detail-button').addEventListener('click', () => { model.detailed = !model.detailed; $('detail-button').setAttribute('aria-pressed', String(model.detailed)); renderLogs(); });
$('clear-log').addEventListener('click', () => { model.logs = []; renderLogs(); });
init().catch((error) => { $('error-banner').textContent = error.message; $('error-banner').hidden = false; connected(false); });
