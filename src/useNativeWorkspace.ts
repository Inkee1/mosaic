import { useEffect, useRef, useState } from 'react';
import type { AppState, Pane } from './model';
import { normalizeUrl } from './model';
import { native } from './native';
import type { NativePaneState } from './native';
import { livePanes } from '../shared/workspaces.mjs';

export function useNativeWorkspace(
  state: AppState,
  focusedId: string | null,
  blocked: boolean,
  generation: number,
  update: (id: string, profileId: string, patch: Partial<Pane>) => void,
  activate: (id: string) => void,
  report: (message: string) => void,
) {
  const [statuses, setStatuses] = useState<Record<string, NativePaneState>>({});
  const current = useRef({ state, focusedId, blocked, generation, update, activate, report });
  current.current = { state, focusedId, blocked, generation, update, activate, report };
  useEffect(() => {
    if (!native) return;
    return native.onEvent((event) => {
      if (event.type === 'refresh') window.dispatchEvent(new Event('mosaic-native-ready'));
      else if (event.type === 'error') current.current.report(event.message);
      else if (event.type === 'activate') current.current.activate(event.paneId);
      else if (event.type === 'shortcut') {
        current.current.activate(event.paneId);
        requestAnimationFrame(() =>
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              code: event.code,
              key: event.code === 'Escape' ? 'Escape' : event.code,
              altKey: true,
              shiftKey: true,
            }),
          ),
        );
      } else if (event.type === 'agent') {
        if (
          !['started', 'completed', 'failed', 'stopped', 'resumed'].includes(event.phase) ||
          (!event.paneId && event.phase !== 'stopped')
        )
          return;
        setStatuses((previous) =>
          Object.fromEntries(
            Object.entries(previous).map(([id, status]) => [
              id,
              !event.paneId || event.paneId === id
                ? { ...status, agentPhase: event.phase }
                : status,
            ]),
          ),
        );
      } else if (event.type === 'pane') {
        if (event.generation !== current.current.generation) return;
        setStatuses((s) => ({ ...s, [event.paneId]: { ...s[event.paneId], ...event } }));
        const patch: Partial<Pane> = {};
        if (event.browser) patch.browser = event.browser;
        if (event.title) patch.title = event.title.slice(0, 120);
        try {
          patch.url = normalizeUrl(event.url);
        } catch {}
        current.current.update(event.paneId, event.profileId, patch);
      }
    });
  }, []);
  useEffect(() => {
    if (!native) return;
    native
      .syncPanes({ panes: livePanes(state), profiles: state.profiles, generation })
      .then((results) => {
        if (generation !== current.current.generation) return;
        setStatuses((previous) =>
          Object.fromEntries(results.map((s) => [s.paneId, { ...previous[s.paneId], ...s }])),
        );
        window.dispatchEvent(new Event('mosaic-native-ready'));
      })
      .catch((error) => current.current.report(String(error.message || error)));
  }, [state.savedSets, state.openSetIds, state.profiles, generation]);
  useEffect(() => {
    if (!native) return;
    let frame = 0,
      last = '';
    let disposed = false;
    const force = () => {
      last = '';
    };
    window.addEventListener('mosaic-native-ready', force);
    const measure = () => {
      if (disposed) return;
      const root = document.querySelector<HTMLElement>('.workspace-viewport');
      if (root) {
        const box = root.getBoundingClientRect();
        const viewport = {
          x: box.left,
          y: box.top,
          width: root.clientWidth,
          height: root.clientHeight,
        };
        const overlays = !!document.querySelector('dialog[open]');
        const items = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.workspace-set:not([hidden]) .browser-pane[data-native="true"]:not(.pane-hidden)',
          ),
        ).map((card) => {
          const rect = card.querySelector('.pane-body')!.getBoundingClientRect();
          return {
            paneId: card.dataset.paneId!,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            viewport,
          };
        });
        const data = {
          items,
          blocked: current.current.blocked || overlays,
          focusId: current.current.focusedId,
        };
        const signature = JSON.stringify(data);
        if (signature !== last) {
          last = signature;
          native!
            .layout(data)
            .catch((error) => current.current.report(String(error.message || error)));
        }
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('mosaic-native-ready', force);
    };
  }, []);
  return statuses;
}
