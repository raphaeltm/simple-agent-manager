import { useQuery } from '@tanstack/react-query';

import { useQueryScope } from '../../hooks/useQueryScope';
import { projectCredentialLimitsQueryOptions } from '../../lib/query-options';
import { CredentialLimitChip } from './CredentialLimitChip';

/**
 * Header chip for the credential a chat session's agent is attributed to.
 * Renders nothing until a sample exists (no spinner: the header must never
 * reflow for data that may never arrive — rule 48).
 */
export function SessionCredentialLimitChip({
  projectId,
  agentSessionId,
}: Readonly<{ projectId: string; agentSessionId: string | null }>) {
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectCredentialLimitsQueryOptions(queryScope, projectId, agentSessionId),
    enabled: Boolean(queryScope && projectId && agentSessionId),
  });
  const credential = query.data?.credentials?.[0];
  if (!credential || !credential.windows?.length) return null;
  return <CredentialLimitChip credential={credential} />;
}
