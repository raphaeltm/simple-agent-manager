import { createContext, useContext } from 'react';
import type { CredentialResponse } from '@simple-agent-manager/shared';

export interface SettingsContextValue {
  credentials: CredentialResponse[];
  loading: boolean;
  reload: () => Promise<void>;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettingsContext(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettingsContext must be used within SettingsContext.Provider');
  return ctx;
}
