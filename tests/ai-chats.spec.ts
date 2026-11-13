import { test, expect, type Page } from '@playwright/test';

// The component is real; only Electron IPC/provider execution is replaced. Mounting it
// independently keeps these tests independent of the host workspace's browser views.
async function mountPanel(page: Page, desktop = true) {
  if (desktop) {
    await page.addInitScript(() => {
      const w = window as any;
      const listeners = new Set<(event: any) => void>();
      const now = '2026-11-10T09:00:00.000Z';
      const chat = (id: string, provider: string, extra: any = {}) => ({
        id, setId: 'brand', title: provider === 'codex' ? '캠페인 분석' : '문구 초안',
        provider, model: '', effort: 'default', paneIds: [], archived: false,
        status: 'idle', createdAt: now, updatedAt: now, messages: [], events: [], ...extra,
      });
      let state = {
        version: 1,
        revision: 1,
        maxConcurrent: 2,
        chats: [chat('codex-chat', 'codex'), chat('claude-chat', 'claude'),
          chat('other-chat', 'codex', { setId: 'research', title: '다른 세트 조사', status: 'running' }),
          chat('archive-chat', 'claude', { title: '이전 초안', archived: true })],
      };
      let providers = [
        { id: 'codex', name: 'Codex', status: 'ready', version: 'test-codex',
          detail: '로컬 런타임에서 확인한 모델', models: [
            { id: 'codex-model-a', label: 'Codex Model A', efforts: ['low', 'high'], defaultEffort: 'low' },
            { id: 'codex-model-b', label: 'Codex Model B', efforts: ['medium'] },
          ] },
        { id: 'claude', name: 'Claude', status: 'ready', version: 'test-claude',
          detail: '로컬 런타임에서 확인한 모델', models: [
            { id: 'claude-model-a', label: 'Claude Model A', efforts: ['high'] },
          ] },
      ];
      const copy = () => structuredClone(state);
      const emit = () => {
        state.revision += 1;
        listeners.forEach((listener) => listener({ type: 'ai', state: copy() }));
      };
      const update = (id: string, patch: any) => {
        state.chats = state.chats.map((item) => item.id === id ? { ...item, ...patch } : item);
        emit();
        return copy();
      };
      w.aiCalls = [];
      w.aiPush = update;
      w.aiSnapshot = copy;
      w.aiEmitSnapshot = (snapshot: any) => listeners.forEach((listener) => listener({ type: 'ai', state: snapshot }));
      w.aiProviderState = (next: any) => { providers = next; };
      w.mosaicNative = {
        aiState: async () => copy(),
        aiProviders: async () => { w.aiCalls.push(['providers']); return structuredClone(providers); },
        aiCreateChat: async (input: any) => {
          w.aiCalls.push(['create', input]);
          if (w.aiDeferCreate) await new Promise((resolve) => { w.aiResolveCreate = resolve; });
          if (w.aiInsertConcurrent) state.chats.push(chat('concurrent-chat', input.provider, { setId: input.setId, title: '동시에 만든 다른 채팅' }));
          const created = chat('created-' + state.chats.length, input.provider, {
            setId: input.setId, title: input.title || '새 채팅',
          });
          state.chats.push(created);
          emit();
          return { ...copy(), createdChatId: created.id };
        },
        aiUpdateChat: async (id: string, patch: any) => {
          w.aiCalls.push(['update', id, patch]);
          return update(id, patch);
        },
        aiForkChat: async (id: string, provider: string, carry: boolean) => {
          w.aiCalls.push(['fork', id, provider, carry]);
          const source = state.chats.find((item) => item.id === id)!;
          state.chats.push(chat('fork-chat', provider, {
            setId: source.setId, title: source.title + ' · ' + provider,
            messages: carry ? [{ id: 'context', role: 'system', content: '최근 보이는 대화 가져옴', createdAt: now }] : [],
          }));
          emit();
          return { ...copy(), createdChatId: 'fork-chat' };
        },
        aiSend: async (id: string, text: string) => {
          w.aiCalls.push(['send', id, text]);
          if (w.aiFailSend) throw new Error('계정에서 이 모델을 사용할 수 없습니다.');
          const current = state.chats.find((item) => item.id === id)!;
          return update(id, { status: 'queued', messages: [...current.messages,
            { id: 'user-message', role: 'user', content: text, createdAt: now }],
          });
        },
        aiStop: async (id?: string) => {
          w.aiCalls.push(['stop', id]);
          state.chats = state.chats.map((item) => !id || item.id === id ? { ...item, status: 'interrupted' } : item);
          emit();
          return copy();
        },
        aiLogin: async (provider: string) => {
          w.aiCalls.push(['login', provider]);
          return { message: '공식 로그인 안내를 열었습니다.' };
        },
        onEvent: (listener: any) => { listeners.add(listener); return () => listeners.delete(listener); },
      };
    });
  }
  await page.route(/\/src\/main\.tsx(?:\?.*)?$/, async (route) => {
    // Reuse Vite's resolved React imports to avoid a separate test entry or new dependency.
    const response = await route.fetch();
    const original = await response.text();
    const react = original.match(/from ["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    const dom = original.match(/from ["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
    if (!react || !dom) throw new Error('Vite React entry imports were not found');
    await route.fulfill({ response, contentType: 'application/javascript', body: `
      import React from ${JSON.stringify(react)};
      import ReactDOM from ${JSON.stringify(dom)};
      import AiChatPanel from '/src/components/AiChatPanel.tsx';
      import '/src/styles.css';
      import '/src/ai.css';
      const root = ReactDOM.createRoot(document.getElementById('root'));
      const panes = [
        {id:'google',title:'Google',url:'https://google.com',profileId:'work',kind:'external',addressOpen:false},
        {id:'naver',title:'네이버',url:'https://naver.com',profileId:'personal',kind:'external',addressOpen:false},
        {id:'demo',title:'샘플 문서',url:'https://mosaic.demo',profileId:'work',kind:'document',addressOpen:false}
      ];
      window.aiChangeSet = (setId) => root.render(React.createElement(AiChatPanel, {
        setId, setName: setId === 'brand' ? '브랜드 워크스페이스' : '리서치',
        panes: setId === 'brand' ? panes : [],
        profiles: [{id:'work',name:'업무용',note:'',color:'#447b64'}, {id:'personal',name:'개인용',note:'',color:'#9a7ab7'}],
        onClose: () => {}
      }));
      document.getElementById('root').style.cssText = 'height:100vh;display:flex;justify-content:flex-end';
      window.aiChangeSet('brand');
    ` });
  });
  await page.goto('/');
}

test('provider controls and per-chat settings collapse independently and remember their state', async ({ page }) => {
  await mountPanel(page);
  const column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await expect(column).toBeVisible();
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('codex-model-a');
  const messages = column.getByRole('log');
  const before = await messages.boundingBox();
  await page.getByRole('button', { name: '연결·새 채팅 접기', exact: true }).click();
  await expect(page.getByRole('button', { name: '새 채팅', exact: true })).toBeHidden();
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toBeVisible();
  await column.getByRole('button', { name: '채팅 설정 접기', exact: true }).click();
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toBeHidden();
  expect((await messages.boundingBox())!.height).toBeGreaterThan(before!.height + 100);
  await page.evaluate(() => (window as any).aiPush('codex-chat', { status: 'running' }));
  await expect(column.getByRole('button', { name: '이 채팅 중지', exact: true })).toBeVisible();
  await expect(column.getByRole('textbox', { name: '메시지', exact: true })).toBeVisible();
  await column.getByRole('button', { name: '채팅 설정 펼치기', exact: true }).click();
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toHaveValue('codex-model-a');
  await column.getByRole('button', { name: '채팅 설정 접기', exact: true }).click();
  await page.getByRole('tab', { name: /문구 초안/ }).click();
  const other = page.getByRole('region', { name: '문구 초안 채팅', exact: true });
  await expect(other.getByRole('combobox', { name: '모델', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /캠페인 분석/ }).click();
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: '연결·새 채팅 펼치기', exact: true })).toBeVisible();
  await expect(column.getByRole('button', { name: '채팅 설정 펼치기', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ai-controls-collapsed.png' });
});

test('streams real state, freezes targets while queued, and stops only the selected conversation', async ({ page }) => {
  await mountPanel(page);
  const column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await expect(column).toBeVisible();
  await column.getByLabel('대상 Google', { exact: true }).check();
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('codex-model-a');
  await column.getByRole('combobox', { name: '추론 강도', exact: true }).selectOption('high');
  await column.getByRole('textbox', { name: '메시지', exact: true }).fill('이 화면의 캠페인을 분석해 줘.');
  await column.getByRole('textbox', { name: '메시지', exact: true }).press('Control+Enter');
  await expect(column.getByText('이 화면의 캠페인을 분석해 줘.', { exact: true })).toBeVisible();
  await expect(column.getByLabel('대상 Google', { exact: true })).toBeDisabled();
  await expect(column.getByRole('button', { name: '메시지 보내기', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).aiPush('codex-chat', {
    status: 'running', appliedModel: 'codex-model-a', appliedEffort: 'high',
    messages: [
      { id: 'user-message', role: 'user', content: '이 화면의 캠페인을 분석해 줘.', createdAt: '2026-11-10T09:00:00Z' },
      { id: 'response', role: 'assistant', content: '캠페인 내용을 확인하고', createdAt: '2026-11-10T09:00:01Z' },
    ],
    events: [{ id: 'action', type: 'tool', message: 'Google 화면 읽기', createdAt: '2026-11-10T09:00:01Z' }],
  }));
  await expect(column.getByText('캠페인 내용을 확인하고', { exact: true })).toBeVisible();
  await column.getByText('작업 기록', { exact: false }).click();
  await expect(column.getByText('Google 화면 읽기', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).aiCalls.filter((call: any) => call[0] === 'providers').length)).toBe(1);
  await column.getByRole('button', { name: '이 채팅 중지', exact: true }).click();
  await expect(column.getByLabel('대상 Google', { exact: true })).toBeEnabled();
  await expect(page.getByText('다른 세트 1개 진행 중', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '모든 채팅 중지', exact: true }).click();
  await expect(page.getByText('다른 세트 1개 진행 중', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).aiCalls.filter((call: any) => call[0] === 'stop'))).toEqual([
    ['stop', 'codex-chat'], ['stop', undefined],
  ]);
});

test('keeps each chat model, effort, draft and explicit targets independent in split view', async ({ page }) => {
  await mountPanel(page);
  let column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('codex-model-a');
  await column.getByRole('combobox', { name: '추론 강도', exact: true }).selectOption('high');
  await column.getByLabel('대상 Google', { exact: true }).check();
  await column.getByRole('textbox', { name: '메시지', exact: true }).fill('아직 보내지 않은 초안');
  await page.getByRole('tab', { name: /문구 초안/ }).click();
  column = page.getByRole('region', { name: '문구 초안 채팅', exact: true });
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toHaveValue('');
  await expect(column.getByLabel('대상 Google', { exact: true })).not.toBeChecked();
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('claude-model-a');
  await column.getByLabel('대상 네이버', { exact: true }).check();
  await page.getByRole('button', { name: '두 채팅 나란히 보기', exact: true }).click();
  await expect(page.locator('.ai-chat-column')).toHaveCount(2);
  const codex = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await expect(codex.getByRole('combobox', { name: '모델', exact: true })).toHaveValue('codex-model-a');
  await expect(codex.getByRole('combobox', { name: '추론 강도', exact: true })).toHaveValue('high');
  await expect(codex.getByLabel('대상 Google', { exact: true })).toBeChecked();
  await expect(codex.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('아직 보내지 않은 초안');
  await expect(column.getByLabel('대상 네이버', { exact: true })).toBeChecked();
  await expect(page.getByLabel('대상 샘플 문서', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.ai-chat-column')).toHaveCount(2);
  const persisted = await page.evaluate(() => localStorage.getItem('mosaic.ai.display.v1'));
  expect(persisted).not.toContain('아직 보내지 않은 초안');
  expect(persisted).not.toContain('messages');
});

test('keeps failed input editable and exposes the provider error without a fake answer', async ({ page }) => {
  await mountPanel(page);
  await page.evaluate(() => { (window as any).aiFailSend = true; });
  const column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await column.getByRole('textbox', { name: '메시지', exact: true }).fill('모델 접근을 확인해 줘');
  await column.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  await expect(column.getByRole('alert')).toContainText('계정에서 이 모델을 사용할 수 없습니다.');
  await expect(column.getByRole('textbox', { name: '메시지', exact: true })).toHaveValue('모델 접근을 확인해 줘');
  await expect(column.locator('[data-message-role="assistant"]')).toHaveCount(0);
  await expect(column.getByRole('button', { name: '메시지 보내기', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).aiPush('codex-chat', {
    status: 'error', error: '실행 중 연결이 끊겼습니다.',
    messages: [{ id: 'partial', role: 'assistant', content: '여기까지 확인했습니다.', createdAt: '2026-11-10T09:00:00Z' }],
  }));
  await expect(column.getByText('여기까지 확인했습니다.', { exact: true })).toBeVisible();
  await expect(column.getByText('실행 중 연결이 끊겼습니다.', { exact: true })).toBeVisible();
});

test('renames, archives, restores and forks with explicitly chosen visible context', async ({ page }) => {
  await mountPanel(page);
  let column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await column.getByRole('button', { name: '채팅 이름 변경', exact: true }).click();
  await column.getByRole('textbox', { name: '채팅 이름', exact: true }).fill('봄 캠페인');
  await column.getByRole('button', { name: '이름 저장', exact: true }).click();
  column = page.getByRole('region', { name: '봄 캠페인 채팅', exact: true });
  await expect(column).toBeVisible();
  await column.getByRole('button', { name: '채팅 보관', exact: true }).click();
  await expect(page.getByRole('tab', { name: /봄 캠페인/ })).toHaveCount(0);
  await page.getByRole('button', { name: /보관함/ }).click();
  await page.getByRole('button', { name: '봄 캠페인 복원', exact: true }).click();
  await page.getByRole('tab', { name: /봄 캠페인/ }).click();
  column = page.getByRole('region', { name: '봄 캠페인 채팅', exact: true });
  await column.getByRole('button', { name: '다른 AI로 새 채팅', exact: true }).click();
  await expect(column.getByLabel('최근 보이는 대화 가져오기', { exact: true })).not.toBeChecked();
  await column.getByLabel('최근 보이는 대화 가져오기', { exact: true }).check();
  await column.getByRole('button', { name: 'Claude로 새 채팅 만들기', exact: true }).click();
  await expect(page.getByRole('region', { name: '봄 캠페인 · claude 채팅', exact: true })).toBeVisible();
  await expect(page.getByText('최근 보이는 대화 가져옴', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).aiCalls.find((call: any) => call[0] === 'fork'))).toEqual([
    'fork', 'codex-chat', 'claude', true,
  ]);
});

test('refreshes live provider availability and never selects a delayed creation in another set', async ({ page }) => {
  await mountPanel(page);
  await page.evaluate(() => (window as any).aiProviderState([
    { id: 'codex', name: 'Codex', status: 'login-required', detail: '공식 CLI 로그인이 필요합니다.', models: [] },
    { id: 'claude', name: 'Claude', status: 'missing', detail: 'Claude Code를 설치해 주세요.', models: [] },
  ]));
  await page.getByRole('button', { name: '연결 상태 새로고침', exact: true }).click();
  await expect(page.getByText('로그인 필요', { exact: true })).toBeVisible();
  await expect(page.getByText('설치 필요', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Codex 로그인', exact: true }).click();
  await expect(page.getByText('공식 로그인 안내를 열었습니다.', { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).aiDeferCreate = true; });
  await page.getByRole('button', { name: '새 채팅', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 새 채팅', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).aiResolveCreate)).toBe('function');
  await page.evaluate(() => (window as any).aiChangeSet('research'));
  await expect(page.getByRole('region', { name: '다른 세트 조사 채팅', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).aiResolveCreate());
  await expect(page.getByRole('region', { name: '다른 세트 조사 채팅', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /새 채팅/ })).toHaveCount(0);
  await page.evaluate(() => (window as any).aiChangeSet('brand'));
  await expect(page.getByRole('region', { name: '새 채팅 채팅', exact: true })).toBeVisible();
});

test('web preview explains desktop execution and never invents an AI response', async ({ page }) => {
  await mountPanel(page, false);
  await expect(page.getByText('데스크톱에서 AI와 대화하세요', { exact: true })).toBeVisible();
  await expect(page.getByText(/설치된 Claude Code와 Codex/)).toBeVisible();
  await expect(page.getByRole('button', { name: '새 채팅', exact: true })).toBeDisabled();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '메시지 보내기', exact: true })).toHaveCount(0);
});

test('older native snapshots cannot roll back streamed text or unlock a running chat', async ({ page }) => {
  await mountPanel(page);
  const column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await expect(column).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.aiOldSnapshot = w.aiSnapshot();
    w.aiPush('codex-chat', {
      status: 'running',
      messages: [{ id: 'latest', role: 'assistant', content: '최신 스트리밍 응답입니다.', createdAt: '2026-11-10T09:00:01Z' }],
    });
  });
  await expect(column.getByText('최신 스트리밍 응답입니다.', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).aiEmitSnapshot((window as any).aiOldSnapshot));
  await expect(column.getByText('최신 스트리밍 응답입니다.', { exact: true })).toBeVisible();
  await expect(column.getByLabel('대상 Google', { exact: true })).toBeDisabled();
});

test('keeps the composer and stop controls reachable in a compact split window', async ({ page }) => {
  await page.setViewportSize({ width: 950, height: 620 });
  await mountPanel(page);
  await page.getByRole('button', { name: '두 채팅 나란히 보기', exact: true }).click();
  await page.evaluate(() => (window as any).aiPush('codex-chat', { status: 'running' }));
  const panel = page.getByRole('complementary', { name: 'AI 채팅 패널' });
  const panelBounds = await panel.boundingBox();
  const controls = [
    page.getByRole('button', { name: '모든 채팅 중지', exact: true }),
    page.getByRole('button', { name: '이 채팅 중지', exact: true }),
    ...await page.getByRole('textbox', { name: '메시지', exact: true }).all(),
  ];
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(panelBounds!.y + panelBounds!.height);
    expect(box!.x).toBeGreaterThanOrEqual(panelBounds!.x);
  }
  await expect(page.locator('.ai-chat-column')).toHaveCount(2);
});

test('changes only next-run settings during a run and offers efforts from the selected live model', async ({ page }) => {
  await mountPanel(page);
  const column = page.getByRole('region', { name: '캠페인 분석 채팅', exact: true });
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('codex-model-a');
  await column.getByRole('combobox', { name: '추론 강도', exact: true }).selectOption('high');
  await page.evaluate(() => (window as any).aiPush('codex-chat', {
    status: 'running', appliedModel: 'codex-model-a', appliedEffort: 'high',
  }));
  await column.getByRole('combobox', { name: '모델', exact: true }).selectOption('codex-model-b');
  await expect(column.getByRole('combobox', { name: '추론 강도', exact: true })).toHaveValue('default');
  await expect(column.getByRole('combobox', { name: '추론 강도', exact: true }).locator('option')).toHaveText(['기본값', '보통 (medium)']);
  await expect(column.getByText('codex-model-a · high', { exact: true })).toBeVisible();
  await expect(column.getByLabel('대상 Google', { exact: true })).toBeDisabled();
  await expect(column.getByRole('button', { name: '채팅 보관', exact: true })).toBeDisabled();
  await column.getByRole('button', { name: '이 채팅 중지', exact: true }).click();
  await expect(column.getByRole('combobox', { name: '모델', exact: true })).toHaveValue('codex-model-b');
});

test('selects the chat created by this request when another chat appears in the same response', async ({ page }) => {
  await mountPanel(page);
  await page.evaluate(() => { (window as any).aiInsertConcurrent = true; });
  await page.getByRole('button', { name: '새 채팅', exact: true }).click();
  await page.getByRole('button', { name: 'Codex 새 채팅', exact: true }).click();
  await expect(page.getByRole('region', { name: '새 채팅 채팅', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: /동시에 만든 다른 채팅/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /새 채팅 Codex/ })).toHaveAttribute('aria-selected', 'true');
});
