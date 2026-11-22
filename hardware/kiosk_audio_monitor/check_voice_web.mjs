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
    let interval;
    const serial = new EventTarget();
    serial.requestPort = async () => {
      if (window.cancelNext) { window.cancelNext = false; throw new DOMException('cancelled', 'NotFoundError'); }
      let streamController;
      const port = {
        readable: new ReadableStream({ start(controller) { streamController = controller; }, cancel() { clearInterval(interval); } }),
        open: async () => { window.usbOpens = (window.usbOpens || 0) + 1; },
        setSignals: async (signals) => { window.lastSignals = signals; interval = setInterval(() => streamController.enqueue(new Uint8Array(512)), 20); },
        close: async () => { clearInterval(interval); window.usbCloses = (window.usbCloses || 0) + 1; },
      };
      return port;
    };
    Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!request.url().startsWith(info.base)) external.push(new URL(request.url()).origin); });
  await page.goto(info.base);
  await expect(page.locator('#invitation')).toBeVisible();
  await expect(page.locator('#connect')).toBeDisabled();
  await page.goto(`${info.base}#access=${info.access}`);
  await expect(page.locator('#connect')).toBeEnabled();
  if (page.url().includes('#')) throw new Error('Invitation remained in URL');
  await page.screenshot({ path: path.join(folder, 'desktop-ready.png'), fullPage: true });
  await page.evaluate(() => { window.cancelNext = true; });
  await page.locator('#connect').click();
  await expect(page.locator('#notice')).toContainText('취소');
  await page.locator('#connect').click();
  await expect(page.locator('.bubble').first()).toContainText('아이스 라떼');
  await expect(page.locator('#disconnect')).toBeVisible();
  const signals = await page.evaluate(() => window.lastSignals);
  if (!signals.dataTerminalReady || signals.requestToSend) throw new Error('Unsafe reset signal configuration');
  await page.locator('#log-toggle').click();
  await expect(page.locator('#logs')).toContainText('문장 확정');
  await page.screenshot({ path: path.join(folder, 'desktop-connected.png'), fullPage: true });
  await page.locator('#disconnect').click();
  await expect(page.locator('#connect')).toBeEnabled();
  await expect(page.locator('#notice')).toContainText('전송을 멈췄어요');
  if (await page.evaluate(() => window.usbCloses) !== 1) throw new Error('Serial port leaked');
  await page.locator('#connect').click();
  await expect(page.locator('#disconnect')).toBeVisible();
  await page.locator('#disconnect').click();
  await expect(page.locator('#connect')).toBeEnabled();
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Overflow at ${width}`);
    await page.screenshot({ path: path.join(folder, `width-${width}.png`), fullPage: true });
  }
  const unsupported = await browser.newContext();
  await unsupported.addInitScript(() => Object.defineProperty(navigator, 'serial', { value: undefined }));
  const alternative = await unsupported.newPage();
  alternative.on('pageerror', (error) => errors.push(error.message));
  await alternative.goto(`${info.base}#access=${info.access}`);
  await expect(alternative.locator('#browser-note')).toContainText('지원하지 않아요');
  await expect(alternative.locator('#connect')).toBeDisabled();
  await alternative.locator('summary').click();
  const download = alternative.waitForEvent('download'); await alternative.locator('#installer').click();
  if ((await download).suggestedFilename() !== 'SWitch-Voice-Setup.cmd') throw new Error('Installer download failed');
  const result = { realHTTPAndServerWorkers: true, simulatedWebSerial: true, microphoneAndSTTAPIsUsed: false, invitation: true, directUSBFlow: true, pickerCancellation: true, safeDTRRTS: true, stopRestart: true, unsupportedBrowserHelp: true, installerDownload: true, widths: [1440, 1024, 390], pageErrors: errors, externalRequests: external };
  await writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
  if (errors.length || external.length) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(result));
} finally {
  await browser.close(); fixture.stdin.end('stop\n'); await once(fixture, 'exit');
}
