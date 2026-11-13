import type { AppState, Workspace, Pane } from '../src/model';
import type { NativePaneState } from '../src/native';
export const MAX_LIVE_PANES: number;
export function migrateSets(state: AppState): AppState;
export function syncActiveSet(state: AppState): AppState;
export function openWorkspaces(state: AppState): Workspace[];
export function livePanes(state: AppState): Pane[];
export function switchSet(state: AppState, id: string): AppState;
export function createSet(state: AppState, workspace: Workspace): AppState;
export function closeSet(state: AppState, id: string): AppState;
export function patchSetPane(
  state: AppState,
  id: string,
  profileId: string,
  patch: Partial<Pane>,
): AppState;
export function mergeNativeLocations(state: AppState, panes: NativePaneState[]): AppState;
