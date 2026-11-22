import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'kiosk-web/package.json'));
const { chromium, expect } = require('@playwright/test');
const fixture = spawn(path.join(here, '.venv/bin/python'), ['-u', path.join(here, 'test_voice_demo.py'), '--fixture'], { cwd: root });
const info = await new Promise((resolve, reject) => { let buffer = ''; fixture.stdout.on('data', (data) => { buffer += data; if (buffer.includes('\n')) { try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); } } }); fixture.once('error', reject); });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const folder = path.join(root, 'tmp/voice-web-qa'); await mkdir(folder, { recursive: true });
const errors = [], external = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
  await context.addInitScript(() => {
    const serial = new EventTarget();
    const makePort = () => {
      let interval, controller;
      return {
        readable: new ReadableStream({ start(c) { controller = c; }, cancel() { clearInterval(interval); } }),
        getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
        open: async () => { window.usbOpens = (window.usbOpens || 0) + 1; },
        setSignals: async (signals) => { window.lastSignals = signals; interval = setInterval(() => controller.enqueue(new Uint8Array(536 * 8)), 8 * 256 / 48000 * 1000); },
        close: async () => { clearInterval(interval); window.usbCloses = (window.usbCloses || 0) + 1; },
      };
    };
    serial.requestPort = async () => {
      sessionStorage.setItem('fixture.pickers', String(Number(sessionStorage.getItem('fixture.pickers') || 0) + 1));
      if (window.cancelNext) { window.cancelNext = false; throw new DOMException('cancelled', 'NotFoundError'); }
      localStorage.setItem('fixture.granted', 'yes'); return makePort();
    };
    serial.getPorts = async () => localStorage.getItem('fixture.granted') ? [makePort()] : [];
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith(info.base)) external.push(new URL(request.url()).origin); });
  let binaryFrames = 0;
  page.on('websocket', (ws) => ws.on('framesent', ({ payload }) => { if (typeof payload !== 'string') binaryFrames++; }));
  const routes = [];
  await page.routeWebSocket('**/api/voice/stream', (client) => {
    const server = client.connectToServer(), entry = { client, server, closed: false }; routes.push(entry);
    const delay = routes.length === 1 ? 1100 : 0;
    client.onMessage((data) => setTimeout(() => { if (!entry.closed) server.send(data); }, delay));
    client.onClose((code, reason) => { entry.closed = true; void server.close({ code, reason }); });
    server.onClose((code, reason) => { entry.closed = true; void client.close({ code, reason }); });
    server.onMessage((data) => {
      const row = JSON.parse(String(data));
      if (row.event === 'turn.accept') {
        for (const event of [
          { event: 'speech_started' }, { event: 'audio_segment', endpoint_seconds: .45 },
          { event: 'recognizing' }, { event: 'stt_usage', model:'gpt-fixture', api_call:true, elapsed:.7, usage:{input_tokens:10,output_tokens:4,total_tokens:14} }, { event: 'transcript', text: '아이스 라떼', elapsed: .7 },
          { event: 'filter_started' }, { event:'filter_usage', model:'jev-fixture', api_call:true, elapsed:.18, usage:{input_tokens:20,output_tokens:10} },
        ]) client.send(JSON.stringify({...event,turn_id:row.turn_id,segment:1,revision:1}));
      }
      client.send(data);
    });
  });
  await page.goto(info.base);
  await expect(page.locator('#connection-modal')).toBeVisible();
  await expect(page.locator('#connect')).toBeDisabled();
  await page.goto(`${info.base}#access=${info.access}`);
  await expect(page.locator('#connect')).toBeEnabled();
  if (page.url().includes('#')) throw new Error('Invitation remained in URL');
  await page.evaluate(() => { window.cancelNext = true; });
  await page.locator('#connect').click(); await expect(page.locator('#notice')).toContainText('cancelled');
  await page.locator('#connect').click();
  await expect(page.locator('#connection-modal')).not.toBeVisible();
  await expect(page.locator('.bubble').first()).toContainText('아이스 라떼', { timeout: 10000 });
  await expect(page.locator('#logs')).toBeVisible();
  await expect(page.locator('[data-step="stt"]')).toHaveClass(/done/);
  await expect(page.locator('[data-step="filter"]')).toHaveClass(/done/);
  await expect(page.locator('#processing-state')).toHaveText('RUNNING');
  await expect(page.locator('#tokens-total')).toHaveText('44');
  await expect(page.locator('#speech-text')).toHaveText('아이스 라떼');
  const signals = await page.evaluate(() => window.lastSignals);
  if (!signals.dataTerminalReady || signals.requestToSend) throw new Error('Unsafe reset signal configuration');
  // 1.1s per-message delay, at full ESP bit rate: no HTTP acknowledgement stall.
  if (routes.length !== 1 || await page.evaluate(() => window.usbOpens) !== 1) throw new Error('Lag disconnected USB');
  await expect(page.locator('.turn-card')).toHaveCount(1);
  await expect(page.locator('#raw-event')).toContainText('fixture-turn');
  await expect(page.locator('#usb-hex')).not.toHaveText('');
  await page.screenshot({ path: path.join(folder, 'desktop-connected.png'), fullPage: true });
  routes[0].closed = true;
  await routes[0].client.close({ code: 1012, reason: 'fixture-network-loss' });
  await routes[0].server.close({ code: 1012 });
  await expect.poll(() => routes.length).toBe(2);
  await expect(page.locator('#connection-message')).toContainText('recovered');
  if (await page.evaluate(() => window.usbOpens) !== 1) throw new Error('Network recovery reopened USB');
  await page.locator('#processing-toggle').click();
  await expect(page.locator('#processing-toggle')).toHaveText('RESUME');
  await expect(page.locator('#processing-toggle')).toBeEnabled();
  const pausedFrames = binaryFrames; await new Promise((resolve) => setTimeout(resolve, 650));
  if (binaryFrames !== pausedFrames) throw new Error('Audio still transmitted while paused');
  await expect(page.locator('#connection-status')).toHaveText('USB CONNECTED');
  await expect(page.locator('#stage')).toContainText('PAUSED');
  const pickerCount = await page.evaluate(() => sessionStorage.getItem('fixture.pickers'));
  await page.reload();
  await expect(page.locator('#connection-status')).toHaveText('USB CONNECTED');
  await expect(page.locator('#processing-toggle')).toHaveText('RESUME');
  await expect(page.locator('#connection-modal')).not.toBeVisible();
  if (await page.evaluate(() => sessionStorage.getItem('fixture.pickers')) !== pickerCount) throw new Error('Reload prompted for USB permission again');
  await page.locator('#processing-toggle').click();
  await expect(page.locator('.bubble').first()).toContainText('아이스 라떼');
  await expect(page.locator('#processing-state')).toHaveText('RUNNING');
  await page.screenshot({ path: path.join(folder, 'desktop-ready.png'), fullPage: true });
  for (const event of [{event:'speech_started'},{event:'transcript',text:'다른 걸로 주세요',segment:1,elapsed:.5},{event:'turn.accept',text:'다른 걸로 주세요',reason:'context_for_agent',stt_seconds:.5,filter_seconds:.2,from_speech_end_seconds:1.3}]) routes.at(-1).client.send(JSON.stringify({...event,turn_id:'second-turn'}));
  await expect(page.locator('#speech-text')).toHaveText('다른 걸로 주세요');
  await page.locator('.turn-card .turn-pick').first().click();
  await expect(page.locator('#focus-turn')).toHaveText('TURN 001');
  await expect(page.locator('#speech-text')).toHaveText('다른 걸로 주세요');
  await expect(page.locator('#logs')).not.toContainText('다른 걸로 주세요');
  const latestLabel=(await page.locator('.turn-card .turn-pick').last().textContent()).match(/^TURN \d+/)[0];
  await page.locator('#follow-turn').click();
  await expect(page.locator('#focus-turn')).toHaveText(latestLabel);
  for (const [width,height] of [[1000,1600],[1600,2560]]) {
    await page.setViewportSize({width,height});
    const layout=await page.evaluate(()=>{
      const rect=(selector)=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,width:r.width,height:r.height};};
      return {bubble:rect('.speech-bubble'),avatar:rect('.conversation .avatar'),metrics:rect('.metrics-bar'),logs:rect('#logs'),raw:rect('.raw-pane'),overflow:document.documentElement.scrollHeight>innerHeight+1};
    });
    if(layout.overflow || layout.bubble.bottom>layout.avatar.y || layout.avatar.bottom>layout.metrics.y || layout.logs.height<70 || layout.raw.bottom>height) throw new Error(`Portrait layout: ${JSON.stringify(layout)}`);
    await expect(page.locator('#speech-text')).toHaveText('다른 걸로 주세요');
    await page.screenshot({path:path.join(folder,`portrait-${width}.png`)});
  }
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Overflow at ${width}`);
    await page.screenshot({ path: path.join(folder, `width-${width}.png`), fullPage: true });
  }
  await page.locator('#connection-open').click(); await expect(page.locator('#connection-modal')).toBeVisible();
  await page.locator('#disconnect').click(); await expect(page.locator('#connect')).toBeEnabled();
  await expect(page.locator('#notice')).toContainText('Transmission stopped');
  if (await page.evaluate(() => window.usbCloses) !== 1) throw new Error('Serial port leaked');
  // Upgrade from the previous page: a browser grant alone must be enough.
  await page.evaluate(() => { const key = `switch.voice.${location.pathname}`; localStorage.removeItem(`${key}.auto`); localStorage.removeItem(`${key}.device`); });
  await page.reload(); await expect(page.locator('#connection-status')).toHaveText('USB CONNECTED');
  await expect(page.locator('#connection-modal')).not.toBeVisible();
  if (await page.evaluate(() => sessionStorage.getItem('fixture.pickers')) !== pickerCount) throw new Error('Existing permission was not reused after upgrade');
  await page.locator('#processing-toggle').click(); await expect(page.locator('#processing-toggle')).toHaveText('RESUME');
  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() => Object.defineProperty(navigator, 'serial', { value: undefined }));
  const alternative = await unsupported.newPage();
  alternative.on('pageerror', (error) => errors.push(error.message));
  await alternative.goto(`${info.base}#access=${info.access}`);
  await expect(alternative.locator('#browser-note')).toContainText('unavailable');
  await expect(alternative.locator('#connect')).toBeDisabled();
  const download = alternative.waitForEvent('download'); await alternative.locator('#installer').click();
  if ((await download).suggestedFilename() !== 'SWitch-Voice-Setup.cmd') throw new Error('Installer download failed');
  const result = { realHTTPAndServerWorkers: true, simulatedWebSerial: true, microphoneAndSTTAPIsUsed: false, invitation: true, directUSBFlow: true, pickerCancellation: true, safeDTRRTS: true, stopRestart: true, alwaysVisibleLogs: true, progressSteps: true, fullESPRate: true, delayedFramesMs: 1100, automaticServerRecovery: true, automaticUSBReload: true, pauseNoAudioTransmission: true, turnGrouping: true, reportedTokenAccounting: true, boundedRawHex: true, unsupportedBrowserHelp: true, installerDownload: true, portrait10to16: true, avatarBelowBubble: true, widths: [1440, 1000, 1600, 1024, 390], pageErrors: errors, externalRequests: external };
  await writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
  if (errors.length || external.length) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  await browser.close(); fixture.stdin.end('stop\n'); await once(fixture, 'exit');
}
