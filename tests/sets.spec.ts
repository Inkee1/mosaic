import { test, expect } from '@playwright/test';

test('renaming active and archived sets preserves their identity, contents and saved names', async ({ page }) => {
  await page.goto('/');
  const note = page.getByRole('textbox', { name: '캠페인 메모', exact: true });
  await note.fill('이름을 바꿔도 유지할 초안');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('mosaic.ui.v1')!));
  await page.getByRole('button', { name: '브랜드 워크스페이스 이름 변경', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('   ');
  await expect(page.getByRole('button', { name: '이름 변경', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('  브랜드 운영  ');
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '브랜드 운영', exact: true })).toBeVisible();
  await expect(note).toHaveValue('이름을 바꿔도 유지할 초안');
  await page.getByRole('button', { name: '리서치 & 아이디어 이름 변경', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('시장 조사');
  await page.getByRole('button', { name: '이름 변경', exact: true }).click();
  await expect(page.getByRole('heading', { name: '브랜드 운영', exact: true })).toBeVisible();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mosaic.ui.v1')!));
  expect(after.activeSetId).toBe(before.activeSetId);
  expect(after.openSetIds).toEqual(before.openSetIds);
  expect(after.savedSets.map((set: any) => [set.id, set.workspace.panes])).toEqual(before.savedSets.map((set: any) => [set.id, set.workspace.panes]));
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await page.getByRole('button', { name: '현재 세트 이름 변경', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('취소할 이름');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '브랜드 운영', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '브랜드 운영', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '시장 조사 · 2개 화면', exact: true }).click();
  await expect(page.getByRole('heading', { name: '시장 조사', exact: true })).toBeVisible();
});

test('set switching retains drafts and each last URL and layout after reload', async ({ page }) => {
  await page.goto('/');
  const note = page.getByRole('textbox', { name: '캠페인 메모', exact: true });
  await note.fill('세트를 바꿔도 남아 있는 초안');
  await page.getByRole('button', { name: '트렌드 리서치 주소창 펼치기', exact: true }).click();
  await page
    .getByRole('textbox', { name: '트렌드 리서치 주소', exact: true })
    .fill('https://research.mosaic.demo/a-last');
  await page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true }).press('Enter');
  await page.getByRole('button', { name: '3열 2행', exact: true }).click();
  await page.getByRole('button', { name: '리서치 & 아이디어 · 2개 화면', exact: true }).click();
  await page.getByRole('button', { name: '트렌드 리서치 주소창 펼치기', exact: true }).click();
  await page
    .getByRole('textbox', { name: '트렌드 리서치 주소', exact: true })
    .fill('https://research.mosaic.demo/b-last');
  await page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true }).press('Enter');
  await page.getByRole('button', { name: '브랜드 워크스페이스 · 4개 화면', exact: true }).click();
  await expect(note).toHaveValue('세트를 바꿔도 남아 있는 초안');
  await expect(page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true })).toHaveValue(
    'https://research.mosaic.demo/a-last',
  );
  await expect(page.getByRole('button', { name: '3열 2행', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.reload();
  await expect(page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true })).toHaveValue(
    'https://research.mosaic.demo/a-last',
  );
  await page.getByRole('button', { name: '리서치 & 아이디어 · 2개 화면', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true })).toHaveValue(
    'https://research.mosaic.demo/b-last',
  );
});

test('sets can close independently, reopen and restore an all-closed app', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '리서치 & 아이디어 · 2개 화면', exact: true }).click();
  await page.getByRole('button', { name: '브랜드 워크스페이스 세트 닫기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '리서치 & 아이디어', exact: true })).toBeVisible();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(2);
  await page.getByRole('button', { name: '리서치 & 아이디어 세트 닫기', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '열린 세트가 없어요', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '열린 세트가 없어요', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '브랜드 워크스페이스 · 4개 화면', exact: true }).click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(4);
});
