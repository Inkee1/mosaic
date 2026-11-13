import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeRuntime } from '../chrome/runtime.mjs';

test('real Chrome keeps isolated sessions, nested popup ownership and drafts across disconnect/reconnect', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    const path = new URL(request.url!, 'http://fixture').pathname;
    response.end(path === '/auth' ? `<title>Auth</title><input id="answer"><button id="finish" onclick="window.opener.opener.postMessage(document.querySelector('#answer').value,location.origin);window.close()">Finish</button>` :
      path === '/popup' ? `<title>Popup</title><button id="next" onclick="window.open('/auth','auth','width=600,height=500')">Login</button>` :
      `<title>Root</title><input id="draft"><button id="open" onclick="document.body.dataset.clicked='yes';document.body.dataset.opened=String(!!window.open('/popup','site','width=700,height=600'))">Open site</button><output id="result"></output><script>addEventListener('message',e=>{if(e.origin===location.origin)document.querySelector('#result').textContent=e.data});addEventListener('mousedown',e=>{document.body.dataset.down=e.target.id+':'+e.isTrusted})</script>`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/';
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-chrome-runtime-'));
  const groups = new Set<any>();
  const runtime = new ChromeRuntime({ directory, onChange: (_id: string, group: any) => groups.add(group) });
  const click = async (contents: any, selector: string) => {
    await contents.focus();
    const point = await contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  try {
    const one = await runtime.open({ paneId: 'one', profileId: 'work', url }); groups.add(one);
    const root = one.target('main');
    await expect.poll(() => root.executeJavaScript('document.title')).toBe('Root');
    await root.executeJavaScript(`document.querySelector('#draft').value='keep this draft';document.cookie='identity=one;path=/'`);
    const two = await runtime.open({ paneId: 'two', profileId: 'work', url }); groups.add(two);
    await expect.poll(() => two.target('main').executeJavaScript('document.title')).toBe('Root');
    expect(await two.target('main').executeJavaScript('document.cookie')).not.toContain('identity=one');
    await click(root, '#open');
    expect(await root.executeJavaScript('document.body.dataset.opened')).toBe('true');
    await expect.poll(async () => (await one.list()).length).toBe(2);
    const popupInfo = (await one.list()).find((target: any) => target.targetId !== 'main')!;
    expect(popupInfo.parentTargetId).toBe('main');
    const popup = one.target(popupInfo.targetId);
    await expect.poll(() => popup.executeJavaScript('document.title')).toBe('Popup');
    await click(popup, '#next');
    await expect.poll(async () => (await one.list()).length).toBe(3);
    const authInfo = (await one.list()).find((target: any) => target.parentTargetId === popupInfo.targetId)!;
    const auth = one.target(authInfo.targetId);
    await expect.poll(() => auth.executeJavaScript('document.title')).toBe('Auth');
    expect(() => two.target(authInfo.targetId)).toThrow();
    expect(await auth.executeJavaScript('document.cookie')).toContain('identity=one');
    await click(auth, '#answer');
    await auth.debugger.sendCommand('Input.insertText', { text: 'connected-response' });
    const image = await auth.capturePage();
    expect(image.toPNG().subarray(1, 4).toString()).toBe('PNG');
    await click(auth, '#finish');
    await expect.poll(() => root.executeJavaScript('document.querySelector("#result").textContent')).toBe('connected-response');
    await expect.poll(async () => (await one.list()).length).toBe(2);
    expect(() => one.target(authInfo.targetId)).toThrow();
    runtime.disconnect('one');
    expect(one.connection.closed).toBe(true);
    const reconnected = await runtime.open({ paneId: 'one', profileId: 'work', url }); groups.add(reconnected);
    expect(await reconnected.target('main').executeJavaScript('document.querySelector("#draft").value')).toBe('keep this draft');
    expect(await reconnected.list()).toHaveLength(2);
    const alternate = await runtime.open({ paneId: 'one', profileId: 'personal', url }); groups.add(alternate);
    expect(alternate).not.toBe(reconnected);
    await expect.poll(() => alternate.target('main').executeJavaScript('document.title')).toBe('Root');
    expect(await alternate.target('main').executeJavaScript('document.cookie')).not.toContain('identity=one');
    runtime.disconnect('one', 'personal');
    expect(reconnected.connection.closed).toBe(false);
    // Reconnect the test-owned profile so the finally block can close its window.
    groups.add(await runtime.open({ paneId: 'one', profileId: 'personal', url }));
  } finally {
    for (const group of groups) if (!group.connection.closed) await group.connection.send('Browser.close').catch(() => {});
    runtime.disconnectAll();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await new Promise(done => setTimeout(done, 250));
  }
});
