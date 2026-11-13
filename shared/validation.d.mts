import type { AppState } from '../src/model';
export function normalizeUrl(input: string): string;
export function validState(value: unknown): value is AppState;
export function validPaneDescriptors(panes: unknown, profiles: unknown): boolean;
