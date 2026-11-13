import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkspaceStore } from './storage.mjs';
import { PaneManager } from './pane-manager.mjs';
import { SessionStore } from './session-store.mjs';
import { CredentialVault, fillCredential } from './credentials.mjs';
import { AccountWindows } from './account-windows.mjs';
import { createAutomation } from './automation.mjs';
import { AgentBridge } from './agent-bridge.mjs';
import { ChatService } from './ai/chat-service.mjs';
import { ProviderRegistry } from './ai/providers.mjs';
import { ChromeRuntime } from './chrome/runtime.mjs';
import { AppServices } from './app-services.mjs';
import { t, setLocale } from '../shared/i18n.mjs';
import { validState, validPaneDescriptors } from '../shared/validation.mjs';
import { migrateSets, mergeNativeLocations, livePanes } from '../shared/workspaces.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
app.setName('Mosaic');
if (process.platform === 'win32') app.setAppUserModelId('org.mosaic.browser');
app.setPath(
  'userData',
  process.env.MOSAIC_USER_DATA || join(app.getPath('appData'), 'MosaicBrowser'),
);
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Electron waits for the entry module to finish before emitting ready.
  // A top-level await of whenReady() would deadlock that initialization.
  app
    .whenReady()
    .then(async () => {
      let releaseConfig = {};
      try { releaseConfig = JSON.parse(readFileSync(join(root, 'release.config.json'), 'utf8')); } catch {}
      let telemetryConfig = {};
      try { telemetryConfig = JSON.parse(readFileSync(join(root, 'telemetry.config.json'), 'utf8')); } catch {}
      const appServices = new AppServices({ directory: app.getPath('userData'), version: app.getVersion(), config: releaseConfig, telemetryConfig, systemLocale: app.getLocale() });
      setLocale(appServices.info().locale);
      appServices.telemetry.start();
      appServices.record('app_open');
      const store = new WorkspaceStore(app.getPath('userData'));
      const storedState = store.load();
      let currentState = storedState ? migrateSets(storedState) : null,
        quitting = false,
        allowExit = false;
      const window = new BrowserWindow({
        title: 'Mosaic',
        width: 1600,
        height: 1000,
        minWidth: 800,
        minHeight: 640,
        backgroundColor: '#f4f5f2',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(root, 'desktop/preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: false,
          webSecurity: true,
        },
      });
      window.setMenu(null);
      const emit = (event) => {
        if (event.type === 'pane' && currentState)
          currentState = mergeNativeLocations(currentState, [event]);
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          window.webContents.send('mosaic:event', event);
      };
      const sessions = new SessionStore(app.getPath('userData'), safeStorage, (message) =>
        emit({ type: 'error', message }),
      );
      const chrome = new ChromeRuntime({ directory: app.getPath('userData') });
      const manager = new PaneManager(window, emit, sessions, chrome);
      const vault = new CredentialVault(app.getPath('userData'), safeStorage);
      const accounts = new AccountWindows(window, manager, root);
      const providers = new ProviderRegistry({ directory: app.getPath('userData'), root });
      const chats = new ChatService({
        directory: app.getPath('userData'), root, registry: providers,
        getWorkspace: () => currentState,
        getPane: (id) => manager.panes.get(id),
        execute: createAutomation(manager), emit, onMetric: event => appServices.record(event),
      });
      const bridge = new AgentBridge({
        execute: (method, args, guard) => chats.executeExternal(method, args, guard),
        getProfile: (id) => manager.get(id).profileId,
        emit: (event) => emit({ ...event, timestamp: event.timestamp || new Date().toISOString() }),
      });
      let bridgeError = '';
      try {
        await bridge.start(join(app.getPath('userData'), 'agent-connection.json'));
      } catch (error) {
        bridgeError = t("로컬 AI 연결을 시작하지 못했어요: ") + error.message;
      }
      manager.onManual = (id) => {
        chats.stopForPane(id);
        if (bridge.info().allowedPaneIds.includes(id)) bridge.stop(id);
      };
      manager.onInput = (id) => chats.userInteracted(id);
      const info = () => ({
        ...bridge.info(),
        error: bridgeError || undefined,
        config: JSON.stringify(
          {
            mcpServers: {
              mosaic: {
                command: 'node',
                args: [
                  join(root, 'scripts/mcp.mjs'),
                  '--connection-file',
                  join(app.getPath('userData'), 'agent-connection.json'),
                ],
              },
            },
          },
          null,
          2,
        ),
      });
      const trusted = (event) =>
        event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
      const handle = (name, fn) =>
        ipcMain.handle(name, (event, ...args) => {
          if (!trusted(event)) throw new Error('IPC sender is not trusted');
          if (quitting && name !== 'mosaic:save') throw new Error(t("앱을 종료하는 중이에요."));
          return fn(...args);
        });
      const profile = (id) => {
        const found = (currentState?.profiles || manager.profiles).find((p) => p.id === id);
        if (!found) throw new Error(t("프로필을 찾을 수 없어요."));
        return found;
      };
      handle('mosaic:profile-login', ({ profileId, provider }) =>
        accounts.open(profile(profileId), provider),
      );
      handle('mosaic:credentials-list', (data) => {
        profile(data.profileId);
        return vault.list(data);
      });
      handle('mosaic:credentials-save', (data) => {
        profile(data.profileId);
        return vault.save(data);
      });
      handle('mosaic:credentials-remove', ({ profileId, credentialId }) => {
        profile(profileId);
        return vault.remove(profileId, credentialId);
      });
      handle('mosaic:credentials-fill', (data) => {
        profile(data.profileId);
        return fillCredential(manager, vault, data);
      });
      ipcMain.on('mosaic:bootstrap', (event) => {
        event.returnValue = trusted(event)
          ? {
              state: currentState,
              version: app.getVersion(),
              dataPath: app.getPath('userData'),
              recovered: store.recovered,
              app: appServices.info(),
            }
          : null;
      });
      handle('mosaic:save', async (state) => {
        if (!validState(state)) throw new Error(t("저장할 구성이 올바르지 않아요."));
        // The quit path owns its final native snapshot. A renderer save queued
        // before quit must not replace those URLs while close approval awaits.
        if (quitting) return;
        currentState = state;
        chats.reconcile();
        await store.save(state);
      });
      handle('mosaic:sync', (data) => {
        if (!data || !Number.isInteger(data.generation) || data.generation < 0)
          throw new Error('Invalid pane generation');
        if (!validPaneDescriptors(data.panes, data.profiles))
          throw new Error('Invalid pane descriptors');
        const result = manager.reconcile(data.panes, data.profiles, data.generation);
        chats.reconcile();
        return result;
      });
      handle('mosaic:layout', (data) => {
        if (
          !data ||
          !Array.isArray(data.items) ||
          data.items.length > 32 ||
          typeof data.blocked !== 'boolean' ||
          !(data.focusId === null || typeof data.focusId === 'string')
        )
          throw new Error('Invalid layout');
        return manager.layout(data);
      });
      handle('mosaic:switch-profile', (data) => {
        if (!data || typeof data.paneId !== 'string' || typeof data.profileId !== 'string')
          throw new Error('Invalid profile change');
        chats.stopForPane(data.paneId);
        return manager.switchProfile(data.paneId, data.profileId);
      });
      handle('mosaic:request-close', (ids) => {
        if (!Array.isArray(ids) || ids.length > 32 || ids.some((id) => typeof id !== 'string'))
          throw new Error('Invalid close request');
        for (const id of ids) chats.stopForPane(id);
        return manager.requestClose([...new Set(ids)]);
      });
      handle('mosaic:command', ({ paneId, action, value }) => {
        if (
          typeof paneId !== 'string' ||
          !['navigate', 'back', 'forward', 'reload', 'stop', 'focus', 'zoom'].includes(action)
        )
          throw new Error('Invalid browser command');
        if (action !== 'focus') manager.userInput(paneId);
        return manager.command(paneId, action, value);
      });
      handle('mosaic:open-chrome', async (paneId) => {
        if (typeof paneId !== 'string') throw new Error('Invalid pane');
        manager.userInput(paneId);
        return manager.openChrome(paneId);
      });
      handle('mosaic:use-mosaic', (paneId) => {
        if (typeof paneId !== 'string') throw new Error('Invalid pane');
        manager.userInput(paneId);
        return manager.useMosaic(paneId);
      });
      handle('mosaic:agent-info', () => info());
      handle('mosaic:agent-access', (data) => {
        if (
          !data ||
          typeof data.enabled !== 'boolean' ||
          !Array.isArray(data.paneIds) ||
          data.paneIds.length > 32
        )
          throw new Error('Invalid agent access');
        const panes = [...new Set(data.paneIds)].map((id) => ({
          id,
          profileId: manager.get(id).profileId,
        }));
        bridge.setAccess({ enabled: data.enabled, panes });
        return info();
      });
      handle('mosaic:agent-stop', (id) => {
        if (id !== undefined && typeof id !== 'string') throw new Error('Invalid pane');
        bridge.stop(id);
        if (id) {
          try {
            void manager.command(id, 'stop').catch(() => {});
          } catch {}
        }
        return info();
      });
      handle('mosaic:agent-resume', (id) => {
        if (typeof id !== 'string') throw new Error('Invalid pane');
        bridge.resume(id);
        return info();
      });
      handle('mosaic:ai-providers', () => chats.providers());
      handle('mosaic:ai-state', () => chats.state());
      handle('mosaic:ai-create', (input) => chats.createChat(input));
      handle('mosaic:ai-update', ({ id, patch }) => chats.updateChat(id, patch));
      handle('mosaic:ai-fork', ({ id, provider, carryContext }) => chats.forkChat(id, provider, carryContext));
      handle('mosaic:ai-send', ({ id, text }) => chats.send(id, text));
      handle('mosaic:ai-stop', (id) => chats.stop(id));
      handle('mosaic:ai-login', (provider) => chats.login(provider));
      handle('mosaic:app-info', () => appServices.info());
      handle('mosaic:app-preferences', async patch => {
        const info = await appServices.setPreferences(patch);
        setLocale(info.locale);
        return info;
      });
      handle('mosaic:check-updates', () => appServices.checkUpdates());
      handle('mosaic:app-link', topic => {
        if (typeof topic !== 'string') throw new TypeError('Invalid help topic');
        return shell.openExternal(appServices.link(topic));
      });
      handle('mosaic:clear-metrics', () => appServices.clearMetrics());
      handle('mosaic:export-diagnostics', async () => {
        const chosen = await dialog.showSaveDialog(window, {
          title: t("개인정보 없는 진단 요약 저장"), defaultPath: 'Mosaic-diagnostics.json',
          filters: [{ name: t("진단 요약"), extensions: ['json'] }],
        });
        if (chosen.canceled || !chosen.filePath) return { saved: false };
        await writeFile(chosen.filePath, JSON.stringify(appServices.diagnostics(), null, 2) + '\n', { mode: 0o600 });
        return { saved: true };
      });

      const entry = pathToFileURL(join(root, 'dist/index.html')).href;
      window.webContents.on('will-navigate', (event, url) => {
        if (url !== entry) event.preventDefault();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.once('ready-to-show', () => window.show());
      app.on('second-instance', () => {
        if (!window.isDestroyed()) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        }
      });
      app.on('window-all-closed', () => app.quit());
      window.on('close', (event) => {
        if (!allowExit) {
          event.preventDefault();
          app.quit();
        }
      });
      app.on('before-quit', (event) => {
        if (allowExit) return;
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        bridge.stop();
        (async () => {
          try {
            currentState = mergeNativeLocations(currentState, manager.list());
            await chats.stop();
            await chats.flush();
            if (currentState) await store.save(currentState);
            await manager.flush();
            if (!(await manager.requestClose([...manager.panes.keys()]))) {
              quitting = false;
              return;
            }
            if (currentState) await store.save(currentState);
            accounts.closeAll();
            await Promise.all([store.flush(), manager.flush(), vault.flush()]);
            appServices.telemetry.stop();
            await appServices.flush().catch(() => {});
            await chats.close();
            await bridge.close();
            manager.closeAll();
            allowExit = true;
            app.quit();
          } catch (error) {
            quitting = false;
            let message = t("앱을 닫지 못했어요: ") + error.message;
            try {
              if (currentState) {
                manager.reconcile(
                  livePanes(currentState),
                  currentState.profiles,
                  manager.generation,
                );
                emit({ type: 'refresh' });
              }
            } catch (recoveryError) {
              message += t(" · 화면 복구 실패: ") + recoveryError.message;
            }
            emit({ type: 'error', message });
          }
        })();
      });
      await window.loadFile(join(root, 'dist/index.html')).catch((error) => {
        // An approved quit can destroy the shell before its initial load settles.
        // Keep genuine startup failures visible, but do not open an error dialog on exit.
        if (!allowExit) throw error;
      });
    })
    .catch((error) => {
      console.error('Mosaic startup failed:', error);
      dialog.showErrorBox(t("Mosaic를 시작하지 못했어요"), String(error.message || error));
      app.exit(1);
    });
}
