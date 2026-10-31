import type { CredentialKind } from '@simple-agent-manager/shared';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** Query params the connect sheet owns; closing the sheet clears all of them. */
const SHEET_PARAMS = ['connect', 'method', 'gcp_setup', 'gcp_error'] as const;
const ANY_PROVIDER = 'any';

/**
 * The connect sheet's open state lives in the URL (`?connect=<provider>`), so
 * deep links ("fix your agent", the Google Cloud OAuth return) open it directly
 * and the browser back button closes it on phones.
 */
export function useConnectSheetState() {
  const [params, setParams] = useSearchParams();
  const connect = params.get('connect');
  const method = params.get('method');

  const open = useCallback(
    (providerId?: string, authMethod?: CredentialKind) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('connect', providerId ?? ANY_PROVIDER);
        if (authMethod) next.set('method', authMethod);
        else next.delete('method');
        return next;
      });
    },
    [setParams]
  );

  const close = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of SHEET_PARAMS) next.delete(key);
        return next;
      },
      { replace: true }
    );
  }, [setParams]);

  return {
    isOpen: connect !== null,
    providerId: connect && connect !== ANY_PROVIDER ? connect : undefined,
    authMethod:
      method === 'api-key' || method === 'oauth-token' ? (method as CredentialKind) : undefined,
    open,
    close,
  };
}
