import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('grid presets and custom dimensions keep all screens', async ({ page }) => {
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await page.getByRole('button', { name: '3열 2행', exact: true }).click();
  await expect(page.getByRole('button', { name: '3열 2행', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '배치 직접 설정', exact: true }).click();
  await page.getByLabel('열 수', { exact: true }).selectOption('4');
  await page.getByLabel('행 수', { exact: true }).selectOption('1');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('mosaic.ui.v1')!).workspace.columns),
    )
    .toBe(4);
  await expect(page.locator('.browser-pane')).toHaveCount(4);
});

test('address folding, invalid schemes and external URL do not pretend to browse', async ({
  page,
}) => {
  await page.getByRole('button', { name: '트렌드 리서치 주소창 펼치기', exact: true }).click();
  const input = page.getByRole('textbox', { name: '트렌드 리서치 주소', exact: true });
  await input.fill('javascript:alert(1)');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('http 또는 https');
  await input.fill('example.com/new');
  await input.press('Enter');
  await expect(page.getByRole('textbox', { name: 'example.com 주소', exact: true })).toHaveValue(
    'https://example.com/new',
  );
  await expect(
    page.getByText('실제 웹 탐색은 Chromium 엔진을 연결하면 사용할 수 있습니다.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'example.com 주소창 접기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'example.com 주소', exact: true })).toHaveCount(0);
});

test('address bar searches ordinary text and preserves the search after reload', async ({ page }) => {
  await page.getByRole('button', { name: '트렌드 리서치 주소창 펼치기', exact: true }).click();
  const address = page.locator('[data-pane-id="pane-0"] .pane-address input');
  const query = '서울 날씨 & 미세먼지';
  await address.fill('  ' + query + '  ');
  await address.press('Enter');
  await expect(address).toHaveValue(/^https:\/\/www\.google\.com\/search\?/);
  expect(new URL(await address.inputValue()).searchParams.get('q')).toBe(query);
  await page.reload();
  await expect(address).toHaveValue(/^https:\/\/www\.google\.com\/search\?/);
  expect(new URL(await address.inputValue()).searchParams.get('q')).toBe(query);
  await address.fill('naver.com');
  await address.press('Enter');
  await expect(address).toHaveValue('https://naver.com/');
});

test('new screens accept a search query as well as a web address', async ({ page }) => {
  await page.getByRole('button', { name: '화면 추가', exact: true }).click();
  await page.locator('#new-url').fill('운동화');
  await page.getByRole('dialog').getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(5);
  const searchPane = page.getByRole('article', { name: 'www.google.com 브라우저', exact: true });
  await expect(searchPane).toBeVisible();
  await searchPane.getByRole('button', { name: 'www.google.com 주소창 펼치기', exact: true }).click();
  const address = searchPane.locator('.pane-address input');
  expect(new URL(await address.inputValue()).searchParams.get('q')).toBe('운동화');
});

test('focus, cycle and picker preserve document edits and inner scroll', async ({ page }) => {
  const note = page.getByRole('textbox', { name: '캠페인 메모', exact: true });
  await note.fill('포커스 전환 뒤에도 유지할 나의 초안');
  const body = page.getByLabel('브랜드 캠페인 노트 콘텐츠', { exact: true });
  await body.evaluate((el) => {
    el.scrollTop = 60;
  });
  await page.getByRole('button', { name: '브랜드 캠페인 노트 크게 보기', exact: true }).click();
  await expect(page.locator('.browser-pane.focused')).toHaveAttribute('data-pane-id', 'pane-1');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.locator('.browser-pane.focused')).toHaveAttribute('data-pane-id', 'pane-2');
  await page.keyboard.press('Alt+Shift+ArrowLeft');
  await expect(note).toHaveValue('포커스 전환 뒤에도 유지할 나의 초안');
  await page.keyboard.press('Alt+Shift+KeyK');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('textbox', { name: '화면 찾기' }).fill('아이디어');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /아이디어 스튜디오/ })
    .click();
  await expect(page.locator('.browser-pane.focused')).toHaveAttribute('data-pane-id', 'pane-3');
  await page.keyboard.press('Escape');
  await expect(page.locator('.browser-pane:visible')).toHaveCount(4);
  await expect(note).toHaveValue('포커스 전환 뒤에도 유지할 나의 초안');
  await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test('new profile and named set keep subsequent pane changes after switching and reload', async ({
  page,
}) => {
  await page.getByRole('button', { name: /브라우저 프로필/ }).click();
  await page.getByRole('textbox', { name: '프로필 이름', exact: true }).fill('고객사 A');
  await page.getByRole('textbox', { name: '프로필 설명', exact: true }).fill('캠페인 작업');
  await page.getByRole('button', { name: '프로필 만들기', exact: true }).click();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await page.getByRole('button', { name: '화면 추가', exact: true }).click();
  await page.getByLabel('주소 또는 검색어', { exact: true }).fill('example.com');
  await page.getByRole('button', { name: /고객사 A 캠페인 작업/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(5);
  await expect(page.getByRole('article', { name: 'example.com 브라우저' })).toContainText(
    '고객사 A',
  );
  await page.getByRole('button', { name: '세트 저장', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('월요일 테스트');
  await page.getByRole('button', { name: '세트 저장하기', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('article', { name: 'example.com 브라우저' })).toContainText(
    '고객사 A',
  );
  await page.getByRole('button', { name: 'example.com 닫기', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await page.getByRole('button', { name: '리서치 & 아이디어 · 2개 화면', exact: true }).click();
  await page
    .locator('.saved-sets')
    .getByRole('button', { name: '월요일 테스트 · 4개 화면', exact: true })
    .click();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(4);
  await page.reload();
  await expect(page.locator('.browser-pane:visible')).toHaveCount(4);
  await expect(page.getByRole('article', { name: 'example.com 브라우저' })).toHaveCount(0);
});

test('inner wheel remains in pane including at boundary; titlebar scrolls workspace', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const workspace = page.getByTestId('workspace-scroll');
  const content = page.getByLabel('트렌드 리서치 콘텐츠', { exact: true });
  await workspace.evaluate((el) => {
    el.scrollTop = 0;
  });
  await content.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => workspace.evaluate((el) => el.scrollTop)).toBe(0);
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(200);
  await expect.poll(() => workspace.evaluate((el) => el.scrollTop)).toBe(0);
  await page.locator('.pane-titlebar').first().hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => workspace.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test('modal traps focus, suspends pane shortcuts, and returns focus', async ({ page }) => {
  const add = page.getByRole('button', { name: '화면 추가', exact: true });
  await add.click();
  const activeBefore = await page.locator('.browser-pane.active').getAttribute('data-pane-id');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.locator('.browser-pane.active')).toHaveAttribute('data-pane-id', activeBefore!);
  for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('web preview never simulates a successful AI run', async ({ page }) => {
  await expect(page.locator('.ai-chat-panel')).toContainText(/데스크톱/);
  await expect(page.getByRole('button', { name: '함께 작업하는 모습 보기', exact: true })).toHaveCount(0);
  await expect(page.locator('.agent-active')).toHaveCount(0);
});

test('last pane removal shows a useful empty state', async ({ page }) => {
  for (const name of [
    '트렌드 리서치',
    '브랜드 캠페인 노트',
    '캠페인 대시보드',
    '아이디어 스튜디오',
  ]) {
    await page.getByRole('button', { name: name + ' 닫기', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '무엇부터 펼쳐볼까요?' })).toBeVisible();
  await page.getByRole('button', { name: '첫 화면 추가', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '문서', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(1);
});

test('corrupt persisted data recovers and storage failure is visible', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('mosaic.ui.v1', '{broken'));
  await page.reload();
  await expect(page.getByRole('status')).toContainText('저장 데이터를 읽지 못해');
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: '3열 2행', exact: true }).click();
  await expect(page.locator('.workspace-status')).toContainText('저장 실패');
  await expect(page.getByRole('status')).toContainText('저장 공간에 쓸 수 없어요');
});

test('theme choice survives refresh', async ({ page }) => {
  await page.getByRole('button', { name: '다크 모드로 전환', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('encoded URL limits cannot corrupt saved work and local ports are accepted', async ({
  page,
}) => {
  await page.getByRole('button', { name: '세트 저장', exact: true }).click();
  await page.getByRole('textbox', { name: '세트 이름', exact: true }).fill('보존할 세트');
  await page.getByRole('button', { name: '세트 저장하기', exact: true }).click();
  await page.getByRole('button', { name: '화면 추가', exact: true }).click();
  await page.getByLabel('주소 또는 검색어', { exact: true }).fill('https://example.com/' + '가'.repeat(250));
  await page.getByRole('dialog').getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('2048');
  await page.getByLabel('주소 또는 검색어', { exact: true }).fill('localhost:3000');
  await page.getByRole('dialog').getByRole('button', { name: '화면 추가', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'localhost 브라우저', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator('.browser-pane')).toHaveCount(5);
  await expect(
    page
      .locator('.saved-sets')
      .getByRole('button', { name: '보존할 세트 · 5개 화면', exact: true }),
  ).toBeVisible();
});

test('return from focus restores the original grid scroll exactly', async ({ page }) => {
  const content = page.getByLabel('브랜드 캠페인 노트 콘텐츠', { exact: true });
  const before = await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(before).toBeGreaterThan(0);
  await page.getByRole('button', { name: '브랜드 캠페인 노트 크게 보기', exact: true }).click();
  await page.getByRole('button', { name: '모든 화면으로', exact: true }).click();
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(before);
});

test('keyboard switching moves input focus away from the previous document', async ({ page }) => {
  const note = page.getByRole('textbox', { name: '캠페인 메모', exact: true });
  await note.fill('이 초안은 변경되면 안 됩니다.');
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.getByLabel('캠페인 대시보드 콘텐츠', { exact: true })).toBeFocused();
  await page.keyboard.type('should-not-type-in-old-pane');
  await expect(note).toHaveValue('이 초안은 변경되면 안 됩니다.');
});
