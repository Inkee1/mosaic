import type { AppState, Pane, Profile } from './model';
import type { LanguagePreference, Locale } from '../shared/i18n.mjs';
import type { AiProviderId, ProviderInfo, AiState, AiChatPatch, AiCreateChatInput } from './ai';

export type NativePaneState = {
  type?: 'pane';
  paneId: string;
  profileId: string;
  url: string;
  title: string;
  loading: boolean;
  error: string;
  compatibility?: 'gate-electron' | '';
  browser?: 'mosaic' | 'chrome';
  chromeConnected?: boolean;
  chromeConnecting?: boolean;
  targetCount?: number;
  activeTargetTitle?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  zoom: number;
  generation?: number;
  agentPhase?: string;
  switching?: boolean;
};
export type AgentInfo = {
  enabled: boolean;
  allowedPaneIds: string[];
  pausedPaneIds: string[];
  port: number;
  connectionFile: string;
  lastClient?: string;
  activeCount: number;
  config?: string;
  error?: string;
};
export type AgentEvent = {
  type: 'agent';
  phase: string;
  paneId?: string;
  method?: string;
  message?: string;
  timestamp?: string;
  actionId?: string;
};
export type NativeEvent =
  | NativePaneState
  | AgentEvent
  | { type: 'ai'; state: AiState }
  | { type: 'refresh' }
  | { type: 'error'; message: string }
  | { type: 'activate'; paneId: string }
  | { type: 'shortcut'; paneId: string; code: string };
type Rect = { x: number; y: number; width: number; height: number };
export type SavedCredential = {
  id: string;
  profileId: string;
  origin: string;
  username: string;
  updatedAt: string;
};
export type AppPreferences = { onboardingDismissed: boolean; metricsEnabled: boolean; telemetryEnabled: boolean; language: LanguagePreference };
export type MetricTotals = { app_open: number; ai_started: number; ai_completed: number; ai_failed: number; ai_cancelled: number };
export type AppInfo = {
  locale: Locale; systemLocale: string;
  version: string; channel: 'stable' | 'beta'; repository: string | null;
  supportAvailable: boolean; updatesConfigured: boolean; preferences: AppPreferences;
  recovered: boolean; storageError: boolean;
  telemetry: { configured: boolean; enabled: boolean; region: 'US' | 'EU' | null; lastSentDay: string | null; sendError: boolean; storageError: boolean };
  metrics: { totals: MetricTotals; activeDays: number; days: Array<MetricTotals & { date: string }> };
};
export type UpdateInfo = { status: 'unconfigured' | 'current' | 'available' | 'error'; currentVersion: string; latestVersion?: string; url?: string; message: string };
export type AppLink = 'codex' | 'claude' | 'releases' | 'issues' | 'support' | 'update';
export interface NativeBridge {
  bootstrap: { state: AppState | null; version: string; dataPath: string; recovered: boolean; app?: AppInfo };
  saveState(state: AppState): Promise<void>;
  syncPanes(data: {
    panes: Pane[];
    profiles: Profile[];
    generation: number;
  }): Promise<NativePaneState[]>;
  switchProfile(paneId: string, profileId: string): Promise<NativePaneState>;
  requestClose(paneIds: string[]): Promise<boolean>;
  openProfileLogin(profileId: string, provider: 'google' | 'instagram' | 'naver'): Promise<void>;
  listCredentials(data: { profileId: string; url?: string }): Promise<SavedCredential[]>;
  saveCredential(data: {
    profileId: string;
    url: string;
    username: string;
    password: string;
  }): Promise<SavedCredential>;
  deleteCredential(profileId: string, credentialId: string): Promise<void>;
  fillCredential(data: {
    paneId: string;
    profileId: string;
    credentialId: string;
    origin: string;
  }): Promise<{ filled: number }>;
  layout(data: {
    items: Array<{ paneId: string; rect: Rect; viewport: Rect }>;
    blocked: boolean;
    focusId: string | null;
  }): Promise<void>;
  command(
    paneId: string,
    action: 'back' | 'forward' | 'reload' | 'stop' | 'focus' | 'navigate' | 'zoom',
    value?: string | number,
  ): Promise<NativePaneState>;
  agentInfo(): Promise<AgentInfo>;
  openInChrome(paneId: string): Promise<NativePaneState>;
  useMosaic(paneId: string): Promise<NativePaneState>;
  setAgentAccess(data: { enabled: boolean; paneIds: string[] }): Promise<AgentInfo>;
  stopAgent(paneId?: string): Promise<AgentInfo>;
  resumeAgent(paneId: string): Promise<AgentInfo>;
  aiProviders(): Promise<ProviderInfo[]>;
  aiState(): Promise<AiState>;
  aiCreateChat(input: AiCreateChatInput): Promise<AiState>;
  aiUpdateChat(id: string, patch: AiChatPatch): Promise<AiState>;
  aiForkChat(id: string, provider: AiProviderId, carryContext: boolean): Promise<AiState>;
  aiSend(id: string, text: string): Promise<AiState>;
  aiStop(id?: string): Promise<AiState>;
  aiLogin(provider: AiProviderId): Promise<{message:string}>;
  appInfo(): Promise<AppInfo>;
  setAppPreferences(patch: Partial<AppPreferences>): Promise<AppInfo>;
  checkUpdates(): Promise<UpdateInfo>;
  openAppLink(topic: AppLink): Promise<void>;
  exportDiagnostics(): Promise<{ saved: boolean }>;
  clearMetrics(): Promise<AppInfo>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
}
declare global {
  interface Window {
    mosaicNative?: NativeBridge;
  }
}
export const native = window.mosaicNative;
