import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('compact chrome leaves the browser workspace directly below its controls', async ({
  page,
}) => {
  await expect(page.getByRole('button', { name: '세트 저장', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '화면 추가', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /브랜드 워크스페이스/ })).toBeVisible();

  const topbar = await page.locator('.topbar').boundingBox();
  const workspace = await page.getByTestId('workspace-scroll').boundingBox();
  expect(topbar!.height).toBeLessThanOrEqual(44);
  expect(workspace!.y).toBeLessThanOrEqual(90);
});

test('sidebar choice persists and stays manually controllable at narrow widths', async ({
  page,
}) => {
  const workspace = page.getByTestId('workspace-scroll');
  const expandedWidth = (await workspace.boundingBox())!.width;
  const collapse = page.getByRole('button', { name: '사이드바 접기', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(page.getByRole('button', { name: '사이드바 펼치기', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect((await workspace.boundingBox())!.width - expandedWidth).toBeGreaterThan(120);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mosaic.sidebar.collapsed')))
    .toBe('true');

  await page.reload();
  await expect(page.getByRole('button', { name: '사이드바 펼치기', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await page.getByRole('button', { name: '사이드바 펼치기', exact: true }).click();
  await expect(page.getByRole('button', { name: '사이드바 접기', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(
    page.locator('.primary-nav').getByText('브라우저 프로필', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '사이드바 접기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(page.getByRole('button', { name: '사이드바 펼치기', exact: true })).toBeVisible();
});

test('enlarging a pane fills the workspace, follows resizing, and restores the grid', async ({ page }) => {
  const viewport = page.getByTestId('workspace-scroll');
  const pane = page.locator('[data-pane-id="pane-0"]');
  const before = (await pane.boundingBox())!;
  await pane.getByRole('button', { name: '트렌드 리서치 크게 보기', exact: true }).click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(1);
  const fillsViewport = async () => {
    const area = (await viewport.boundingBox())!;
    const card = (await pane.boundingBox())!;
    return {
      top: Math.round(card.y - area.y),
      bottom: Math.round(area.y + area.height - card.y - card.height),
      horizontalSpace: Math.round(area.width - card.width),
    };
  };
  await expect.poll(fillsViewport).toMatchObject({ top: 16, bottom: 16 });
  expect((await fillsViewport()).horizontalSpace).toBeLessThanOrEqual(50);
  await page.setViewportSize({ width: 1200, height: 800 });
  await expect.poll(fillsViewport).toMatchObject({ top: 12, bottom: 12 });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await pane.getByRole('button', { name: '트렌드 리서치 줄이기', exact: true }).click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(4);
  await expect.poll(async () => {
    const after = (await pane.boundingBox())!;
    return { width: Math.round(after.width), height: Math.round(after.height) };
  }).toEqual({ width: Math.round(before.width), height: Math.round(before.height) });
});

test('collapsed sidebar keeps profiles, saved sets, workspace, theme and help usable', async ({
  page,
}) => {
  await page.getByRole('button', { name: '세트 저장', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('사이드바 테스트 세트');
  await page.getByRole('button', { name: '세트 저장하기', exact: true }).click();
  await expect(page.getByRole('button', { name: '사이드바 접기', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '사이드바 접기', exact: true }).click();

  await page.getByRole('button', { name: /브라우저 프로필/ }).click();
  await expect(page.getByRole('textbox', { name: '프로필 이름', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.getByRole('button', { name: '키보드 단축키', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(0);
  await page
    .locator('.saved-sets')
    .getByRole('button', { name: '사이드바 테스트 세트 · 4개 화면', exact: true })
    .click();
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await page.getByRole('button', { name: '세트 저장', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '세트 이름', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.getByRole('button', { name: '새로운 작업 공간 · 0개 화면', exact: true }).click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(0);
  await page.getByRole('button', { name: '새 세트 만들기', exact: true }).click();
  await expect(page.locator('.saved-sets .set-row')).toHaveCount(3);
});
