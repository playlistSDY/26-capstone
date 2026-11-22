// Opt-in: exercises the deployed HTTPS page and real STT using synthetic USB.
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../..');
const require = createRequire(path.join(root, 'kiosk-web/package.json'));
const { chromium, expect } = require('@playwright/test');
if (process.argv.length !== 4) throw new Error('Usage: node check_voice_web_live.mjs PRIVATE_DEMO_JSON SYNTHETIC_WAV');
const config = JSON.parse(await readFile(process.argv[2], 'utf8')), wav = await readFile(process.argv[3]);
let pcm;
for (let offset = 12; offset + 8 <= wav.length;) { const size = wav.readUInt32LE(offset + 4); if (wav.toString('ascii', offset, offset + 4) === 'data') { pcm = wav.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
if (!pcm) throw new Error('Missing WAV data');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1120 } });
  await context.addInitScript((base64) => {
    const source = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); let cursor = 0, sequence = 0, timer;
    const crc = (bytes) => { let v = 0xffffffff; for (const b of bytes) { v ^= b; for (let k = 0; k < 8; k++) v = (v >>> 1) ^ ((v & 1) ? 0xedb88320 : 0); } return (v ^ 0xffffffff) >>> 0; };
    const serial = new EventTarget();
    serial.requestPort = async () => {
      let controller;
      return { readable: new ReadableStream({ start(c) { controller = c; }, cancel() { clearInterval(timer); } }), open: async () => {}, close: async () => clearInterval(timer), setSignals: async () => {
        timer = setInterval(() => {
          const chunk = new Uint8Array(536 * 8);
          for (let n = 0; n < 8; n++) {
            const block = new Uint8Array(512); if (window.startFixture && cursor < source.length) { block.set(source.subarray(cursor, cursor + 512)); cursor += 512; }
            const at = n * 536, view = new DataView(chunk.buffer, at, 24); chunk.set(new TextEncoder().encode('SWPCM01\n'), at);
            view.setUint32(8, 48000, true); view.setUint16(12, 256, true); view.setUint8(14, 2); view.setUint8(15, 1); view.setUint32(16, sequence++, true); view.setUint32(20, crc(block), true); chunk.set(block, at + 24);
          }
          controller.enqueue(chunk);
        }, 8 * 256 / 48000 * 1000);
      } };
    };
    Object.defineProperty(navigator, 'serial', { value: serial });
  }, pcm.toString('base64'));
  page = await context.newPage(); const errors = [], apiFailures = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.url().includes('/api/') && response.status() >= 400) apiFailures.push(response.status()); });
  await page.goto(`${config.url}#access=${config.access}`);
  await expect(page.locator('#connect')).toBeEnabled({ timeout: 12000 });
  await page.locator('#connect').click();
  await expect(page.locator('#disconnect')).toBeVisible({ timeout: 12000 });
  await page.evaluate(() => { window.startFixture = true; });
  await expect(page.locator('.bubble').first()).toContainText('아이스 아메리카노', { timeout: 25000 });
  await page.locator('#log-toggle').click();
  const folder = path.join(root, 'tmp/voice-web-live-qa'); await mkdir(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, 'deployed-connected.png'), fullPage: true });
  const result = { actualPublicHTTPS: true, actualSTT: true, syntheticUSB: true, physicalESPTested: false, text: await page.locator('.bubble p').first().textContent(), timing: await page.locator('#timing').textContent(), errors, apiFailures };
  await page.locator('#disconnect').click(); await expect(page.locator('#connect')).toBeEnabled();
  result.stopReleased = true; await writeFile(path.join(folder, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (errors.length || apiFailures.length) throw new Error('Live web check failed');
} finally { if (page) await page.close(); await browser.close(); }
