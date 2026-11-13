import { t } from './i18n';

export type AiProviderId = 'claude' | 'codex';

export type AiModel = {
  id: string;
  label: string;
  efforts: string[];
  defaultEffort?: string;
};

export type ProviderInfo = {
  id: AiProviderId;
  name: string;
  status: 'ready' | 'login-required' | 'missing' | 'error';
  version?: string;
  detail?: string;
  models: AiModel[];
};

export type AiMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
};

export type AiAction = {
  id: string;
  type: string;
  message: string;
  createdAt: string;
};

export type AiChatStatus =
  | 'idle' | 'queued' | 'running' | 'stopping' | 'completed' | 'interrupted' | 'error';

export type AiChat = {
  id: string;
  setId: string;
  title: string;
  provider: AiProviderId;
  model: string;
  effort: string;
  paneIds: string[];
  archived: boolean;
  status: AiChatStatus;
  createdAt: string;
  updatedAt: string;
  messages: AiMessage[];
  events: AiAction[];
  error?: string;
  sessionId?: string;
  appliedModel?: string;
  appliedEffort?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type AiState = {
  version: 1;
  revision?: number;
  createdChatId?: string;
  chats: AiChat[];
  maxConcurrent: number;
  recoveryNotice?: string;
};

export type AiChatPatch = Partial<Pick<AiChat, 'title' | 'model' | 'effort' | 'paneIds' | 'archived'>>;
export type AiCreateChatInput = { setId: string; provider?: AiProviderId; title?: string };

export const providerName = (provider: AiProviderId) => provider === 'claude' ? 'Claude' : 'Codex';
export const isChatActive = (chat: AiChat) =>
  chat.status === 'queued' || chat.status === 'running' || chat.status === 'stopping';

export const chatStatusLabel: Record<AiChatStatus, string> = {
  get idle() { return t('준비됨'); },
  get queued() { return t('순서 대기'); },
  get running() { return t('응답 중'); },
  get stopping() { return t('중지 중'); },
  get completed() { return t('완료'); },
  get interrupted() { return t('중단됨'); },
  get error() { return t('오류'); },
};

export const providerStatusLabel: Record<ProviderInfo['status'], string> = {
  get ready() { return t('연결됨'); },
  get 'login-required'() { return t('로그인 필요'); },
  get missing() { return t('설치 필요'); },
  get error() { return t('연결 오류'); },
};
