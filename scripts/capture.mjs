import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:4317');
  await page.evaluate(() => document.fonts.ready);
  await mkdir('docs/previews', { recursive: true });
  await page.screenshot({ path: 'docs/previews/mosaic-overview.png' });
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/mosaic-sidebar-collapsed.png' });
  await page.getByRole('button', { name: '사이드바 펼치기', exact: true }).click();
  await page.getByRole('button', { name: '브랜드 캠페인 노트 크게 보기', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/mosaic-focus.png' });
  await page.getByRole('button', { name: '모든 화면으로', exact: true }).click();
  await page.getByRole('button', { name: '화면 추가', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '리서치', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/mosaic-add-screen.png' });
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: 'docs/previews/mosaic-compact.png' });
  await page.getByRole('button', { name: '리서치 & 아이디어 · 2개 화면', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/mosaic-sets.png' });
  await page.getByRole('button', { name: '리서치 & 아이디어 세트 닫기', exact: true }).click();
  await page.screenshot({ path: 'docs/previews/mosaic-sets-closed.png' });
  console.log(JSON.stringify({ screenshots: 7, errors }));
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
