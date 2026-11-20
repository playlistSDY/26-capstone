import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const base = process.env.RECEIPT_QA_URL || 'http://127.0.0.1:5173/';
const root = path.resolve('..');
const out = path.join(root, 'output/pdf');
await fs.mkdir(out, { recursive: true });
await fs.mkdir('qa', { recursive: true });
await fs.mkdir('public/assets/receipts', { recursive: true });
const css = await fs.readFile('src/receipt-paper.css', 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const report = { url: base, variants: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.goto(base);
  await page.getByRole('button', { name: '영수증 시안', exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  for (const variant of ['receipt', 'pickup']) {
    if (variant === 'pickup') await page.getByRole('button', { name: /픽업 주문서/ }).click();
    const paper = page.locator('.thermal-receipt');
    await expect(paper).toContainText('024');
    await page.screenshot({ path: `qa/${variant}-preview.png` });
    const html = await paper.evaluate(el => el.outerHTML);
    const sheet = await browser.newPage({ viewport: { width: 400, height: 1100 } });
    const font = new URL('assets/fonts/PretendardVariable.woff2', base).href;
    await sheet.setContent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>@font-face{font-family:Pretendard;src:url("${font}") format("woff2");font-weight:100 900}html,body{margin:0;padding:0;background:white}${css}</style></head><body>${html}</body></html>`);
    await sheet.evaluate(() => document.fonts.ready);
    const geometry = await sheet.locator('.thermal-receipt').evaluate(el => ({
      heightMm: Math.ceil(el.scrollHeight * 25.4 / 96) + 2,
      width: el.offsetWidth,
      overflow: el.scrollWidth > el.clientWidth,
    }));
    if (geometry.overflow) throw Error('Receipt exceeds its paper width');
    await sheet.addStyleTag({ content: `@page{size:80mm ${geometry.heightMm}mm;margin:0}` });
    const file = path.join(out, variant === 'receipt' ? 'SWitch_영수증_80mm_시안.pdf' : 'SWitch_픽업주문서_80mm_시안.pdf');
    await sheet.pdf({ path: file, preferCSSPageSize: true, printBackground: false, displayHeaderFooter: false });
    await fs.copyFile(file, `public/assets/receipts/sample-${variant}-80mm.pdf`);
    report.variants.push({ variant, file, ...geometry });
    await sheet.close();
  }
  await fs.writeFile('qa/receipt-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
