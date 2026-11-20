import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';

await fs.mkdir('qa', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:5173/');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'qa/mac-preview.png' });
  await page.getByRole('button', { name: /포장할게요/ }).click();
  for (const [name, price] of [['아메리카노', '3,200'], ['카페라떼', '4,200'], ['바닐라라떼', '4,500'], ['연유라떼', '4,500']]) {
    await page.getByRole('button', { name: `${name} ${price}원`, exact: true }).click();
    await page.getByRole('button', { name: /차갑게/ }).click();
    if (name === '아메리카노') await page.screenshot({ path: 'qa/options.png' });
    await page.getByRole('button', { name: `${price}원 담기`, exact: true }).click();
  }
  await page.getByRole('status').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '주문 내역 위로' }).click();
  await expect.poll(() => page.locator('.dock-lines').evaluate(el => el.scrollTop)).toBe(0);
  await page.screenshot({ path: 'qa/mac-order-preview.png' });

  await page.setViewportSize({ width: 800, height: 1280 });
  await page.goto('http://127.0.0.1:5173/?kiosk=1');
  await page.getByRole('status').waitFor({ state: 'hidden' });
  await page.screenshot({ path: 'qa/menu-order.png' });
  const assets = await page.locator('.product-card img').evaluateAll(imgs => imgs.map(img => {
    const r = img.getBoundingClientRect();
    return { name: img.alt, url: img.getAttribute('src'), naturalWidth: img.naturalWidth, width: r.width, height: r.height, objectFit: getComputedStyle(img).objectFit };
  }));
  for (const asset of assets) {
    if (!asset.naturalWidth || asset.width < 100 || asset.height < 100 || asset.objectFit !== 'contain') throw Error('Invalid image geometry: ' + asset.name);
    if (!(await fs.stat('public' + asset.url)).size) throw Error('Empty asset: ' + asset.url);
  }
  await fs.writeFile('qa/asset-report.json', JSON.stringify(assets, null, 2));
  await page.getByRole('button', { name: '결제하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '이전으로', exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/order-review.png' });
  await page.getByRole('button', { name: '확인하고 결제하기', exact: true }).click();
  await page.screenshot({ path: 'qa/payment-methods.png' });
  console.log(`Saved UI screenshots; verified ${assets.length} supplied menu image slots.`);
} finally { await browser.close(); }
