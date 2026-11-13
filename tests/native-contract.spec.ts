import { test, expect } from '@playwright/test';

// Renderer/IPC contract only. Native child view rendering is tested separately.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    const listeners = new Set<any>();
    let panes: any[] = [];
    let access = {
      enabled: false,
      allowedPaneIds: [] as string[],
      pausedPaneIds: [],
      activeCount: 0,
      config: '{}',
    };
    w.nativeCalls = [];
    w.nativeEmit = (event: any) => listeners.forEach((listener) => listener(event));
    const describe = (pane: any) => ({
      paneId: pane.id,
      profileId: pane.profileId,
      title: pane.title,
      url: pane.url,
      loading: false,
      error: '',
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
    });
    w.mosaicNative = {
      bootstrap: { state: null, version: 'test', dataPath: 'test', recovered: false },
      saveState: async (state: any) => {
        w.nativeSaved = state;
      },
      syncPanes: async (data: any) => {
        panes = data.panes;
        w.nativeCalls.push(['sync', data]);
        return panes.filter((p) => p.kind === 'external').map(describe);
      },
      layout: async (data: any) => {
        w.nativeLayout = data;
      },
      switchProfile: async (id: string, profileId: string) => {
        if (w.failProfile) throw new Error('새 페이지에 연결할 수 없어요. 기존 화면을 유지합니다.');
        const pane = panes.find((p) => p.id === id);
        return describe({ ...pane, profileId });
      },
      requestClose: async (ids: string[]) => {
        w.nativeCalls.push(['requestClose', ids]);
        if (w.deferClose)
          return new Promise((resolve) => {
            w.resolveClose = resolve;
          });
        return !w.cancelClose;
      },
      command: async (id: string, action: string, value: any) => {
        w.nativeCalls.push(['command', id, action, value]);
        return describe(panes.find((p) => p.id === id));
      },
      agentInfo: async () => access,
      aiState: async () => ({ version: 1, chats: [], maxConcurrent: 2 }),
      aiProviders: async () => [],
      setAgentAccess: async (data: any) => {
        access = { ...access, enabled: data.enabled, allowedPaneIds: data.paneIds };
        w.nativeCalls.push(['access', data]);
        w.nativeEmit({ type: 'agent', phase: 'access' });
        return access;
      },
      stopAgent: async () => {
        access.enabled = false;
        return access;
      },
      resumeAgent: async () => access,
      onEvent: (listener: any) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
  await page.goto('/');
});

test('failed native profile switch and cancelled close preserve current configuration', async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).failProfile = true;
    (window as any).cancelClose = true;
  });
  await page.getByRole('combobox', { name: 'Google 프로필', exact: true }).selectOption('work');
  await page.getByRole('button', { name: '프로필 변경하기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('기존 화면을 유지');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Google 프로필', exact: true })).toHaveValue(
    'personal',
  );
  await page.getByRole('button', { name: 'Google 닫기', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await page.getByRole('button', { name: '새 작업 공간', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(4);
  await expect(page.locator('.browser-pane:visible')).toHaveCount(0);
  await page.getByRole('button', { name: '브랜드 워크스페이스 세트 닫기', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '브랜드 워크스페이스 세트 닫기', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '브랜드 워크스페이스 · 4개 화면', exact: true }).click();
  await page.evaluate(() => {
    (window as any).cancelClose = false;
  });
  await page.getByRole('button', { name: 'Google 닫기', exact: true }).click();
  await expect(page.locator('.browser-pane')).toHaveCount(3);
});

test('closing one pane preserves another pane navigation received during approval', async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).deferClose = true;
  });
  await page.getByRole('button', { name: 'Google 닫기', exact: true }).click();
  await page.evaluate(() => {
    (window as any).nativeEmit({
      type: 'pane',
      generation: 0,
      paneId: 'pane-1',
      profileId: 'work',
      title: 'Updated page',
      url: 'https://example.org/new',
      loading: false,
      error: '',
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
    });
  });
  await expect(page.locator('[data-pane-id="pane-1"] .pane-title b')).toHaveText('Updated page');
  await page.evaluate(() => {
    (window as any).resolveClose(true);
  });
  await expect(page.locator('.browser-pane')).toHaveCount(3);
  await expect(page.locator('[data-pane-id="pane-1"] .pane-title b')).toHaveText('Updated page');
  expect(
    await page.evaluate(
      () => (window as any).nativeSaved.workspace.panes.find((p: any) => p.id === 'pane-1').url,
    ),
  ).toBe('https://example.org/new');
});

test('native renderer reports bounds, navigation, focus and modal blocking', async ({ page }) => {
  await expect(page.locator('[data-native="true"]')).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayout?.items.length)).toBe(4);
  await page.getByRole('button', { name: 'Google 주소창 펼치기', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Google 주소', exact: true })
    .fill('https://example.com/');
  await page.getByRole('textbox', { name: 'Google 주소', exact: true }).press('Enter');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).nativeCalls.some(
          (call: any) =>
            call[0] === 'command' && call[2] === 'navigate' && call[3] === 'https://example.com/',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'example.com 크게 보기', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayout?.items.length)).toBe(1);
  await page
    .getByRole('combobox', { name: 'example.com 프로필', exact: true })
    .selectOption('work');
  await expect(page.getByRole('dialog')).toContainText('저장하지 않은 입력은 사라집니다');
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayout?.blocked)).toBe(true);
  await page.keyboard.press('Alt+Shift+ArrowRight');
  await expect(page.locator('[data-pane-id="pane-0"]')).toHaveClass(/focused/);
  await page.getByRole('button', { name: '프로필 변경하기', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).nativeSaved.workspace.panes[0].profileId))
    .toBe('work');
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayout?.blocked)).toBe(false);
});

test('agent panel reopens with exact grants and preserves simultaneous status', async ({
  page,
}) => {
  await page.getByRole('button', { name: '외부 MCP 연결', exact: true }).click();
  const checks = page.locator('.live-target input');
  await expect(checks).toHaveCount(4);
  await checks.nth(0).check();
  await page.getByRole('button', { name: '선택한 화면 연결 허용', exact: true }).click();
  await page.getByRole('button', { name: '에이전트 패널 접기', exact: true }).click();
  await page.getByRole('button', { name: '외부 MCP 연결', exact: true }).click();
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await checks.nth(0).uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).nativeCalls.filter((call: any) => call[0] === 'access').at(-1)[1],
      ),
    )
    .toEqual({ enabled: false, paneIds: [] });
  await page.evaluate(() => {
    const emit = (window as any).nativeEmit;
    emit({ type: 'agent', phase: 'started', paneId: 'pane-0' });
    emit({ type: 'agent', phase: 'started', paneId: 'pane-1' });
    emit({ type: 'agent', phase: 'completed', paneId: 'pane-0' });
    emit({ type: 'agent', phase: 'state' });
  });
  await expect(page.locator('[data-pane-id="pane-1"]')).toHaveClass(/agent-active/);
  await expect(page.locator('[data-pane-id="pane-0"]')).not.toHaveClass(/agent-active/);
});
