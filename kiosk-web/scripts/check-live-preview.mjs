import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';

const config = JSON.parse(await fs.readFile('dev/live-preview.json', 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [], frames = [];
page.on('pageerror', error => errors.push(error.message));
page.on('websocket', socket => socket.on('framereceived', frame => {
  try { frames.push(JSON.parse(String(frame.payload))); } catch { /* heartbeat */ }
}));
const marker = '\n/* switch-live-preview-probe-20261119 */\n';
const css = 'src/styles.css';
try {
  await page.goto(config.url, { waitUntil: 'networkidle', timeout: 45000 });
  await expect(page.getByRole('button', { name: /먹고 갈게요/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px Pretendard'))).toBe(true);
  await page.screenshot({ path: 'qa/live-preview.png' });
  await page.getByRole('button', { name: /포장할게요/ }).click();
  await expect.poll(() => page.locator('.product-card img').evaluateAll(imgs => imgs.length === 12 && imgs.every(img => img.complete && img.naturalWidth > 0)), { timeout: 30000 }).toBe(true);
  const assets = await page.locator('.product-card img').evaluateAll(imgs => imgs.map(img => img.getAttribute('src')));
  if (assets.some(src => !src.startsWith(config.basePath))) throw Error('Incorrect public asset base path');
  await page.getByRole('button', { name: '아메리카노 3,200원', exact: true }).click();
  await page.getByRole('button', { name: /차갑게/ }).click();
  await page.getByRole('button', { name: '3,200원 담기', exact: true }).click();
  await page.getByRole('button', { name: '결제하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '이전으로', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '확인하고 결제하기', exact: true }).click();
  await page.getByRole('button', { name: '신용·체크카드' }).click();
  await page.getByRole('button', { name: '결제 리더기', exact: true }).click();
  await expect(page.getByRole('heading', {name:'주문이 완료됐어요'})).toBeVisible();
  await expect(page.getByText('맛있게 드세요!', {exact:true})).toBeVisible();
  await fs.appendFile(css, marker);
  await expect.poll(() => frames.some(frame => frame.type === 'update' && frame.updates?.some(update => update.path?.includes('styles.css'))), { timeout: 20000 }).toBe(true);
  const state = JSON.parse(await fs.readFile('.live-preview/status.json', 'utf8'));
  const report = { url: config.url, expiresAt: null, menuAssets: assets.length, fontLoaded: true, orderFlow: 'passed', hotUpdate: 'passed', sync: state.status, pageErrors: errors };
  if (errors.length) throw Error(errors.join('\n'));
  await fs.writeFile('qa/live-preview-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  const current = await fs.readFile(css, 'utf8');
  if (current.includes(marker)) await fs.writeFile(css, current.replace(marker, ''));
  await browser.close();
}
