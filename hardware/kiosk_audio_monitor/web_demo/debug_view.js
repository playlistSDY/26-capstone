const $ = (id) => document.getElementById(id);
const n = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const ms = (v) => Number.isFinite(v) ? `${Math.round(v * 1000)} ms` : '—';
const count = (v) => Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
const labels = { capture: 'CAPTURE', stt: 'STT', merge: 'TURN BUFFER', filter: 'GATE' };
const pctl = (a, q) => a.length ? a.slice().sort((x,y) => x-y)[Math.ceil(a.length*q)-1] : undefined;
const compact = (row) => {
  if (row.event === 'started') return `ASR=${row.model} GATE=${row.filter}:${row.gate_model || 'default'} VAD=${row.noise_suppression || 'none'}`;
  if (row.event === 'audio_segment') return `seg=${row.segment} audio=${row.audio_seconds ?? '—'}s pre=${row.pre_roll_seconds ?? '—'}s voiced=${row.voiced_seconds ?? '—'}s`;
  if (row.event.endsWith('_usage')) return `${row.model || row.provider} in=${row.usage?.input_tokens ?? '?'} out=${row.usage?.output_tokens ?? '?'} ${ms(row.elapsed)}`;
  if (row.text) return row.text;
  return ({ ready:'PCM ready',speech_started:'Voice detected',recognizing:'Transcription request',filter_started:'Decision request',decision_stale:'Superseded revision',stopped:'Stream stopped' })[row.event] || (row.message || row.event).split('\n').filter(Boolean)[0];
};

export class DebugView {
  constructor() {
    this.turns = new Map(); this.order = []; this.system = []; this.focus = null; this.follow = true; this.turnNumber = 0;
    this.session = 'initial'; this.lastMeter = {}; this.level = {}; this.history = [];
    this.usageKeys = new Set(); this.input = this.output = this.total = this.apiCalls = this.unknownUsage = this.errors = 0;
    this.latency = { stt: [], filter: [], final: [] }; this.selectedEvent = null;
    this.usbTotal = 0; this.usbLast = new Uint8Array(); this.lastRate = 0; this.rateStart = performance.now(); this.rateBytes = 0;
    $('follow-turn').addEventListener('click', () => { this.follow = true; this.systemFocus=false; this.focus = this.order.at(-1) || null; this.selectedEvent = null; this.schedule(); });
    $('system-log').addEventListener('click', () => { this.follow=false;this.systemFocus=true;this.focus=null;this.selectedEvent=null;this.schedule(); });
    $('log-format').addEventListener('click', () => { this.jsonLogs = !this.jsonLogs; $('log-format').textContent = this.jsonLogs ? 'COMPACT' : 'JSON'; this.schedule(); });
    this.timer = setInterval(() => this.paintLive(), 250);
    this.schedule();
  }
  setSession(session) { this.session = session; }
  observeUSB(value) { this.usbTotal += value.length; const tail = new Uint8Array(Math.min(64, this.usbLast.length + value.length)); const all = value.length >= 64 ? value.subarray(value.length-64) : new Uint8Array([...this.usbLast, ...value]); tail.set(all.subarray(all.length-tail.length)); this.usbLast = tail; }
  attachStream(stream) { this.stream = stream; }
  handle(row) {
    if (row.event === 'meter') { this.lastMeter = row; this.history.push([row.raw_probability ?? row.probability ?? 0,row.enhanced_probability ?? 0]); if (this.history.length > 64) this.history.shift(); return; }
    if (row.event === 'level') { this.level = row; return; }
    if (row.event === 'started') { $('asr-model').textContent = row.model || '—'; $('gate-model').textContent = row.gate_model || row.filter || '—'; $('denoise-mode').textContent = row.noise_suppression || 'none'; }
    const event = { ...row, received_at: performance.now(), stream_session: this.session };
    if (row.turn_id) {
      const key = `${this.session}:${row.turn_id}`;
      if (!this.turns.has(key)) { this.turns.set(key, { key, id: row.turn_id, number: ++this.turnNumber, events: [], segments: new Map(), stages: {}, status: 'OPEN', input:0,output:0,total:0,unknown:0 }); this.order.push(key); }
      const turn = this.turns.get(key); turn.events.push(event); if (turn.events.length>100) turn.events.shift();
      while (this.order.length > 24) this.turns.delete(this.order.shift());
      if (this.follow || (!this.focus && !this.systemFocus)) { this.focus = key; this.selectedEvent = null; }
      this.updateTurn(turn, event);
      this.account(event, turn);
    } else { this.system.push(event); if (this.system.length>40) this.system.shift(); }
    if (row.event.endsWith('_error')) this.errors++;
    this.schedule();
  }
  updateTurn(t, r) {
    const mark = (stage, status, description, seconds) => { t.stages[stage] = { status, description, seconds, at: performance.now() }; };
    if (r.segment) { if (!t.segments.has(r.segment)) t.segments.set(r.segment, {}); Object.assign(t.segments.get(r.segment), r.event === 'audio_segment' ? { audio:r.audio_seconds,pre:r.pre_roll_seconds } : r.event === 'transcript' ? { text:r.text,asr:r.elapsed } : {}); }
    if (r.event === 'speech_started') { mark('capture','active','Voice active'); t.status='CAPTURE'; for(const k of ['stt','merge','filter']) mark(k,'','Pending'); }
    if (r.event === 'audio_segment') mark('capture','done',`SEG ${r.segment} · ${r.audio_seconds ?? '—'}s`,r.endpoint_seconds);
    if (r.event === 'recognizing') { mark('stt','active',`SEG ${r.segment}`); t.status='STT'; }
    if (r.event === 'transcript') { t.stt=r.elapsed; t.text=r.text; mark('stt','done','Transcribed',r.elapsed); mark('merge','active','Continuation window'); t.status='BUFFER'; }
    if (r.event === 'filter_started') { t.text=r.text || t.text; mark('filter','active',`REV ${r.revision}`); t.status='GATE'; }
    if (r.event === 'filter_usage') { t.gate=r.elapsed; mark('filter','done',r.api_call ? 'API response' : 'Fast path',r.elapsed); }
    if (r.event === 'turn.hold' || r.event === 'turn.wait') { t.text=r.text || t.text; mark('merge','active',r.event==='turn.wait'?'Waiting for speech':'Holding decision'); t.status=r.event==='turn.wait'?'WAIT':'HOLD'; }
    if (['turn.accept','turn.ignore','turn.clarify'].includes(r.event)) {
      t.text=r.text; t.result=r; t.status={ 'turn.accept':'PASS','turn.ignore':'IGNORE','turn.clarify':'REVIEW' }[r.event];
      for (const key of ['capture','merge']) mark(key,'done','Complete',t.stages[key]?.seconds); mark('filter',r.event==='turn.clarify'?'warn':'done',r.reason,r.filter_seconds);
      t.stt=r.stt_seconds ?? t.stt; t.gate=r.filter_seconds ?? t.gate; t.after=r.after_stt_seconds; t.final=r.from_speech_end_seconds;
      if(Number.isFinite(t.final)) { this.latency.final.push(t.final); if(this.latency.final.length>128)this.latency.final.shift(); }
    }
    if (r.event==='audio_rejected') { t.status='REJECTED'; mark('capture','done','Non-speech'); }
    if (r.event.endsWith('_error') || r.event==='busy') { t.status='ERROR'; mark(['stt_error','busy'].includes(r.event)?'stt':'filter','warn',r.error || r.event); }
  }
  account(r,t) {
    if (!['stt_usage','filter_usage'].includes(r.event)) return;
    const key = `${this.session}:${r.turn_id}:${r.event}:${r.segment ?? r.revision}`;
    if (this.usageKeys.has(key)) return; this.usageKeys.add(key); if(this.usageKeys.size>4096)this.usageKeys.delete(this.usageKeys.values().next().value);
    if (!r.api_call) return;
    this.apiCalls++;
    const u = r.usage || {}, valid = Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens);
    if (valid) { const total = Number.isFinite(u.total_tokens) ? u.total_tokens : u.input_tokens+u.output_tokens; this.input+=u.input_tokens;this.output+=u.output_tokens;this.total+=total;t.input+=u.input_tokens;t.output+=u.output_tokens;t.total+=total; }
    else { this.unknownUsage++; t.unknown++; }
    const kind=r.event==='stt_usage'?'stt':'filter';
    if(Number.isFinite(r.elapsed)) { this.latency[kind].push(r.elapsed);if(this.latency[kind].length>128)this.latency[kind].shift(); }
  }
  schedule() { if(!this.pending) this.pending=setTimeout(()=>{this.pending=null;this.render();},80); }
  render() {
    const focused=this.turns.get(this.focus);
    const latest=this.turns.get(this.order.at(-1));
    $('speech-text').textContent=latest?.text || (latest ? '…' : '—');
    $('speech-status').textContent=latest?.status || 'IDLE';
    $('speech-meta').textContent=latest ? `TURN ${String(latest.number).padStart(3,'0')} · ${ms(latest.final)} · ${count(latest.total)} tokens${latest.unknown?' + ?':''}` : 'No speech yet';
    $('turn-count').textContent=count(this.order.length);
    const cards=this.order.map(key=>{
      const t=this.turns.get(key), card=n('article',undefined,`turn-card ${t.key===this.focus?'selected':''} bubble`);
      const head=n('div',undefined,'turn-head'), pick=n('button',`TURN ${String(t.number).padStart(3,'0')} · ${t.id.slice(0,8)}`,'turn-pick');
      pick.addEventListener('click',()=>{this.focus=key;this.follow=false;this.systemFocus=false;this.selectedEvent=null;this.schedule();});
      head.append(pick,n('span',t.status,`tag ${t.status.toLowerCase()}`));
      const text=n('p',t.text || '…','message-text');
      const stages=n('div',undefined,'mini-stages'); for(const name of ['capture','stt','merge','filter']) stages.append(n('span',labels[name],t.stages[name]?.status || ''));
      const segments=n('div',undefined,'segments'); for(const [id,s]of t.segments) {const row=n('div');row.append(n('b',`SEG ${String(id).padStart(2,'0')}`),n('span',s.text || `audio=${s.audio ?? '—'}s · pre=${s.pre ?? '—'}s`),n('small',ms(s.asr)));segments.append(row);}
      const meta=n('div',undefined,'turn-meta'); meta.append(n('span',`ASR ${ms(t.stt)} · GATE ${ms(t.gate)} · E2E ${ms(t.final)}`),n('span',`TOKENS ${count(t.total)}${t.unknown?' + ?':''}`));
      card.append(head,text,stages,segments,meta); return card;
    });
    const atBottom=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<100;
    $('messages').replaceChildren(...(cards.length?cards:[n('div','NO TURNS · CONNECT MIC AND START CAPTURE','empty-console')])); if(atBottom&&this.follow)$('messages').scrollTop=$('messages').scrollHeight;
    $('focus-turn').textContent=focused?`TURN ${String(focused.number).padStart(3,'0')}`:'SYSTEM';
    $('follow-turn').classList.toggle('active',this.follow);
    const events=focused?focused.events:this.system;
    $('log-count').textContent=count(events.length);
    $('logs').replaceChildren(...events.slice().reverse().map(r=>{
      const row=n('button',undefined,'event-row'); row.append(n('time',new Date(r.time*1000||Date.now()).toLocaleTimeString('en-GB',{hour12:false})),n('b',r.event),n(this.jsonLogs?'pre':'span',this.jsonLogs?JSON.stringify(r):compact(r)));
      row.addEventListener('click',()=>{this.follow=false;this.selectedEvent=r;$('follow-turn').classList.remove('active');$('raw-event').textContent=JSON.stringify(r,null,2);});return row;
    }));
    const last=this.selectedEvent || events.at(-1) || {};
    $('raw-event').textContent=JSON.stringify(last,null,2);
    for(const key of ['capture','stt','merge','filter']) {
      const el=document.querySelector(`[data-step="${key}"]`),s=focused?.stages[key];el.className=`pipeline-step ${s?.status||''}`;el.querySelector('.step-description').textContent=s?.description||'Idle';el.querySelector('.step-time').textContent=ms(s?.seconds);
    }
    $('candidate').textContent=focused?.text || '—'; $('candidate-badge').textContent=focused?.status || 'IDLE';
    $('candidate-result').textContent=focused?.result?.reason || 'No final decision';
    $('route').textContent=focused?.result?.usage?.model || focused?.result?.usage?.route || '—';
    $('after-stt').textContent=ms(focused?.after);$('stt-time').textContent=ms(focused?.stt);$('filter-time').textContent=ms(focused?.gate);$('timing').textContent=ms(focused?.final);
    for(const [id,v]of [['tokens-in',this.input],['tokens-out',this.output],['tokens-total',this.total],['api-calls',this.apiCalls],['usage-unknown',this.unknownUsage],['api-errors',this.errors]])$(id).textContent=count(v);
    for(const key of ['stt','filter']) {$(key+'-p50').textContent=ms(pctl(this.latency[key],.5));$(key+'-p95').textContent=ms(pctl(this.latency[key],.95));}
    $('last-e2e').textContent=ms(this.latency.final.at(-1));
  }
  paintLive() {
    const m=this.lastMeter, l=this.level;
    for(const[id,v]of [['rms',m.rms],['noise-value',m.noise],['threshold-value',m.threshold],['probability',m.probability],['vad-raw',m.raw_probability],['vad-clean',m.enhanced_probability],['rx-packets',l.packets],['packet-gaps',l.gaps],['crc-errors',l.bad]]) $(id).textContent=Number.isFinite(v)?(id.startsWith('vad')||id==='probability'?v.toFixed(3):count(v)):'—';
    $('packet-errors').textContent=`${l.gaps??0} / ${l.bad??0}`;
    $('level').style.width=`${Math.min(100,(m.probability||0)*100)}%`;
    const elapsed=performance.now()-this.rateStart;if(elapsed>=1000){this.lastRate=(this.usbTotal-this.rateBytes)*1000/elapsed;this.rateBytes=this.usbTotal;this.rateStart=performance.now();}
    $('usb-rate').textContent=`${(this.lastRate/1024).toFixed(1)} KiB/s`; $('usb-bytes').textContent=count(this.usbTotal);
    $('tx-buffer').textContent=`${count((this.stream?.bytes||0)+(this.stream?.socket?.bufferedAmount||0))} B`;
    $('usb-hex').textContent=Array.from(this.usbLast,(b)=>b.toString(16).padStart(2,'0')).join(' ');
    for(const [id,index]of [['vad-raw-line',0],['vad-clean-line',1]]) $(id).setAttribute('points',this.history.map((r,i)=>`${i*4},${48-Math.min(1,r[index])*46}`).join(' '));
    const focused=this.turns.get(this.focus); if(focused)for(const [key,s]of Object.entries(focused.stages))if(s.status==='active')document.querySelector(`[data-step="${key}"] .step-time`).textContent=`${Math.round(performance.now()-s.at)} ms LIVE`;
  }
  clear() { this.turns.clear();this.order=[];this.focus=null;this.systemFocus=false;this.selectedEvent=null;this.schedule(); }
  clearLogs() { const t=this.turns.get(this.focus);if(t)t.events=[];else this.system=[];this.selectedEvent=null;this.schedule(); }
  pause() { for(const t of this.turns.values())if(!t.result){t.status='PAUSED';for(const s of Object.values(t.stages))if(s.status==='active'){s.status='';s.description='Cancelled';}} this.schedule(); }
}
