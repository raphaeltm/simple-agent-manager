/**
 * MCP tool `get_credential_limits` — remaining provider usage for the
 * credentials a session or project uses (Category A: direct D1, no VM proxy).
 *
 * Reads the same service the browser routes use
 * (`services/credential-limit-events/read.ts`), so agents and people see one
 * view. Identity comes only from the verified MCP token; the only client input
 * is the `scope` enum.
 */
import {
  credentialLimitFamilyLabel,
  type CredentialLimitsResponse,
  credentialLimitWindowLabel,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import {
  listProjectCredentialLimits,
  resolveAgentSessionCredentialReference,
} from '../../services/credential-limit-events/read';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

type CredentialLimitsScope = 'session' | 'project';

function parseCredentialLimitsScope(args: Record<string, unknown>): CredentialLimitsScope | null {
  const scope = args.scope;
  if (scope === undefined || scope === 'session') return 'session';
  if (scope === 'project') return 'project';
  return null;
}

/** One human-readable line per window so agents can act without parsing JSON. */
function summarizeCredentialLimits(response: CredentialLimitsResponse): string[] {
  const lines: string[] = [];
  for (const credential of response.credentials) {
    for (const window of credential.windows) {
      const family = credentialLimitFamilyLabel(window.windowType);
      const label = credentialLimitWindowLabel(window.windowType, window.windowMinutes);
      const used =
        window.utilizationPercent === null
          ? 'usage unknown'
          : `${Math.round(window.utilizationPercent)}% used`;
      const resets =
        window.resetsAt === null ? '' : `, resets ${new Date(window.resetsAt).toISOString()}`;
      lines.push(
        `${family} ${label} (${credential.credentialSource} credential): ${used}, level ${window.level}${resets}`
      );
    }
  }
  return lines;
}

export async function handleGetCredentialLimits(
  requestId: string | number | null,
  args: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const scope = parseCredentialLimitsScope(args);
  if (!scope) {
    return jsonRpcError(requestId, INVALID_PARAMS, "scope must be 'session' or 'project'");
  }
  try {
    let credentialReference: string | null | undefined;
    if (scope === 'session') {
      if (!tokenData.agentSessionId) {
        return jsonRpcSuccess(requestId, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  scope,
                  credentials: [],
                  note: 'This session has no agent session attribution yet; retry with scope "project".',
                },
                null,
                2
              ),
            },
          ],
        });
      }
      credentialReference = await resolveAgentSessionCredentialReference(env, {
        projectId: tokenData.projectId,
        agentSessionId: tokenData.agentSessionId,
      });
      if (!credentialReference) {
        return jsonRpcSuccess(requestId, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  scope,
                  credentials: [],
                  note: "No usage samples have been recorded for this session's credential yet.",
                },
                null,
                2
              ),
            },
          ],
        });
      }
    }
    const response = await listProjectCredentialLimits(env, {
      projectId: tokenData.projectId,
      userId: tokenData.userId,
      credentialReference,
    });
    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              scope,
              generatedAt: new Date(response.generatedAt).toISOString(),
              summary: summarizeCredentialLimits(response),
              credentials: response.credentials,
            },
            null,
            2
          ),
        },
      ],
    });
  } catch (e) {
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      `Failed to read credential limits: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
