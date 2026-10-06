import type { CredentialResponse } from '@simple-agent-manager/shared';
import { createContext, useContext } from 'react';

export interface SettingsContextValue {
  credentials: CredentialResponse[];
  /**
   * True only when there is no credential data yet. A background refetch leaves this
   * `false` so consumers keep rendering the list they already have
   * (`.claude/rules/48-stale-while-revalidate-ui.md`).
   */
  loading: boolean;
  /** True while a refetch runs on top of existing data. For subtle indicators only. */
  isRefreshing: boolean;
  reload: () => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettingsContext must be used within SettingsContext.Provider');
  return ctx;
}
