import { test, expect, type Locator, type Page } from '@playwright/test';
import type { AppState } from '../src/model';

test.use({ locale: 'en-US' });

test('browser preview can override the system language and keep that choice after reload', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('article', { name: 'Trend research browser', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('button', { name: '화면 추가', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.getByRole('combobox', { name: '언어', exact: true }).selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

// These saved names intentionally overlap translation keys. User-owned values must
// remain Korean even when the same words elsewhere are English interface labels.
const workspace = {
  id: 'saved-korean', name: '새로운 작업 공간', columns: 2, rows: 1,
  panes: [
    { id: 'document-pane', title: '한국어 메모', url: 'https://docs.mosaic.demo/campaign', profileId: 'saved-profile', kind: 'document' as const, addressOpen: false },
    { id: 'website-pane', title: '새 프로필', url: 'https://example.test/original', profileId: 'saved-profile', kind: 'external' as const, addressOpen: true },
  ],
};
const savedKoreanState: AppState = {
  version: 1, theme: 'light', activeSetId: 'saved-korean', openSetIds: ['saved-korean'],
  profiles: [{ id: 'saved-profile', name: '브라우저 프로필', note: '사용자 프로필', color: '#447b64' }],
  workspace,
  savedSets: [{ id: 'saved-korean', savedAt: '2026-11-12T00:00:00.000Z', workspace }],
};

async function mountNative(page: Page, initialState: AppState | null = null) {
  // No provider, website, analytics, or font requests leave this local UI test.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.addInitScript(({ initialState }) => {
    const w = window as any;
    const preferences = JSON.parse(localStorage.getItem('test.i18n.preferences') ||
      '{"language":"system","onboardingDismissed":true,"metricsEnabled":false,"telemetryEnabled":false}');
    const storedState = localStorage.getItem('test.i18n.workspace');
    const info = () => ({
      version: '0.7.1', channel: 'beta', repository: null, supportAvailable: true,
      updatesConfigured: false, systemLocale: 'en-US',
      locale: preferences.language === 'ko' ? 'ko' : 'en',
      preferences: { ...preferences }, recovered: false, storageError: false,
      telemetry: { configured: true, enabled: preferences.telemetryEnabled, region: 'US', lastSentDay: null, sendError: false, storageError: false },
      metrics: { totals: { app_open: 0, ai_started: 0, ai_completed: 0, ai_failed: 0, ai_cancelled: 0 }, activeDays: 0, days: [] },
    });
    w.preferenceWrites = [];
    w.mosaicNative = {
      bootstrap: { state: storedState ? JSON.parse(storedState) : initialState, version: '0.7.1', dataPath: 'test-only', recovered: false, app: info() },
      saveState: async (state: any) => { localStorage.setItem('test.i18n.workspace', JSON.stringify(state)); },
      syncPanes: async () => [], layout: async () => {},
      aiState: async () => ({ version: 1, revision: 1, chats: [], maxConcurrent: 2 }),
      aiProviders: async () => [
        { id: 'codex', name: 'Codex', status: 'missing', models: [] },
        { id: 'claude', name: 'Claude Code', status: 'login-required', models: [] },
      ],
      appInfo: async () => info(),
      setAppPreferences: async (patch: any) => {
        w.preferenceWrites.push(structuredClone(patch));
        Object.assign(preferences, patch);
        localStorage.setItem('test.i18n.preferences', JSON.stringify(preferences));
        return info();
      },
      onEvent: () => () => {},
    };
  }, { initialState });
  await page.goto('/');
}

async function expectDialogFits(dialog: Locator, viewportWidth: number) {
  await expect(dialog).toBeVisible();
  const dimensions = await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(viewportWidth);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test('English system startup localizes controls without changing independent consent choices', async ({ page }) => {
  await mountNative(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Mosaic — Many panes, one workflow');
  await expect(page.getByRole('heading', { level: 1, name: 'Brand workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add pane', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mosaic settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Mosaic settings', exact: true });
  await expect(settings.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('system');
  await expect(settings.getByRole('heading', { name: 'Getting started', exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Codex installation guide', exact: true })).toBeVisible();
  await expect(settings.getByRole('checkbox', { name: 'Record usage counts on this device' })).not.toBeChecked();
  await expect(settings.getByRole('checkbox', { name: 'Participate in usage counting', exact: true })).not.toBeChecked();
  await expect(settings.getByText('These counts are not automatically sent to the developer.', { exact: true })).toBeVisible();

  await settings.getByRole('checkbox', { name: 'Record usage counts on this device' }).check();
  await settings.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
  const koreanSettings = page.getByRole('dialog', { name: 'Mosaic 설정', exact: true });
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(koreanSettings.getByRole('checkbox', { name: '이 기기에 사용 횟수 기록' })).toBeChecked();
  await expect(koreanSettings.getByRole('checkbox', { name: '사용자 수 집계에 참여', exact: true })).not.toBeChecked();
  await expect(koreanSettings.getByText('제작자에게 자동 전송하지 않습니다.', { exact: true })).toBeVisible();

  await koreanSettings.getByRole('combobox', { name: '언어', exact: true }).selectOption('en');
  await expect(settings.getByRole('checkbox', { name: 'Record usage counts on this device' })).toBeChecked();
  await expect(settings.getByRole('checkbox', { name: 'Participate in usage counting', exact: true })).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).preferenceWrites)).toEqual([
    { metricsEnabled: true }, { language: 'ko' }, { language: 'en' },
  ]);
});

test('language switches preserve mounted panes, Korean user content, and persisted explicit overrides', async ({ page }) => {
  await mountNative(page, savedKoreanState);
  const memo = page.locator('[data-pane-id="document-pane"] .document-note');
  const address = page.locator('[data-pane-id="website-pane"] .pane-address input');
  await memo.fill('새로운 화면 추가');
  await address.fill('한국어 검색어 & keep:{name}');
  const memoNode = await memo.elementHandle();
  const addressNode = await address.elementHandle();
  await page.getByRole('button', { name: 'Mosaic settings', exact: true }).click();
  const settingsNode = await page.getByRole('dialog').elementHandle();

  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
  await expect(page.getByRole('dialog', { name: 'Mosaic 설정', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page).toHaveTitle('Mosaic — 여러 화면, 하나의 흐름');
  await expect(memo).toHaveValue('새로운 화면 추가');
  await expect(address).toHaveValue('한국어 검색어 & keep:{name}');
  await expect(page.locator('.topbar h1')).toHaveText('새로운 작업 공간');
  await expect(page.locator('[data-pane-id="website-pane"] .pane-title b')).toHaveText('새 프로필');

  await page.getByRole('combobox', { name: '언어', exact: true }).selectOption('en');
  await expect(page.getByRole('dialog', { name: 'Mosaic settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Mosaic — Many panes, one workflow');
  expect(await memo.evaluate((element, original) => element === original, memoNode)).toBe(true);
  expect(await address.evaluate((element, original) => element === original, addressNode)).toBe(true);
  expect(await page.getByRole('dialog').evaluate((element, original) => element === original, settingsNode)).toBe(true);
  await expect(memo).toHaveValue('새로운 화면 추가');
  await expect(address).toHaveValue('한국어 검색어 & keep:{name}');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '새로운 작업 공간', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '새 프로필 profile', exact: true }).locator('option:checked')).toHaveText('브라우저 프로필');
  await page.getByRole('button', { name: 'Browser profiles', exact: true }).click();
  await expect(page.getByRole('dialog').locator('.managed-profile b')).toHaveText('브라우저 프로필');
  await expect(page.getByRole('dialog').locator('.managed-profile small')).toHaveText('사용자 프로필');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // Korean must override an English system locale after a fresh renderer starts.
  await page.getByRole('button', { name: 'Mosaic settings', exact: true }).click();
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByRole('heading', { level: 1, name: '새로운 작업 공간', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mosaic 설정', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '언어', exact: true })).toHaveValue('ko');
  await page.getByRole('combobox', { name: '언어', exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Mosaic settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
});

test('English settings, profile creation, pane creation, and keyboard help fit an 820px viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 820, height: 650 });
  await mountNative(page, savedKoreanState);
  await page.getByRole('button', { name: 'Mosaic settings', exact: true }).click();
  await expectDialogFits(page.getByRole('dialog', { name: 'Mosaic settings', exact: true }), 820);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Browser profiles', exact: true }).click();
  const profiles = page.getByRole('dialog', { name: 'My browser profiles', exact: true });
  await expectDialogFits(profiles, 820);
  await profiles.getByRole('textbox', { name: 'Profile name', exact: true }).fill('영문 화면에서 만든 팀');
  await profiles.getByRole('textbox', { name: 'Profile description', exact: true }).fill('원문 설명');
  await profiles.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(profiles.locator('.managed-profile').filter({ hasText: '영문 화면에서 만든 팀' })).toBeVisible();
  await expectDialogFits(profiles, 820);
  await page.screenshot({ path: testInfo.outputPath('english-profiles-820.png') });
  await profiles.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('button', { name: 'Add pane', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add a new pane', exact: true });
  await expectDialogFits(add, 820);
  await add.getByRole('textbox', { name: 'Address or search term', exact: true }).fill('example.test/new?label=서울');
  await add.locator('.profile-option').filter({ hasText: '영문 화면에서 만든 팀' }).click();
  await add.getByRole('button', { name: 'Add pane', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(3);
  const newPane = page.getByRole('article', { name: 'example.test browser', exact: true });
  await expect(newPane.getByRole('combobox', { name: 'example.test profile', exact: true }).locator('option:checked')).toHaveText('영문 화면에서 만든 팀');
  await newPane.getByRole('button', { name: 'Expand example.test address bar', exact: true }).click();
  await expect(newPane.getByRole('textbox', { name: 'example.test address', exact: true })).toHaveValue('https://example.test/new?label=%EC%84%9C%EC%9A%B8');

  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Shortcuts to keep you in flow', exact: true });
  await expectDialogFits(help, 820);
  await expect(help.getByText('Pane switcher', { exact: true })).toBeVisible();
  await expect(help.getByText('Alt + Shift + K', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('english-help-820.png') });
  await help.getByRole('button', { name: 'Got it', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
