/**
 * Candidate loading and upstream-error parsing for {@link CodexRefreshLock}.
 *
 * Extracted from `codex-refresh-lock.ts` to keep that Durable Object under the
 * file-size limit (`.claude/rules/18-file-size-limits.md`). Called inside the
 * DO's refresh mutex, so every read here is serialized with the write-back.
 */
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { decrypt } from '../services/encryption';
import {
  type CodexAuthIdentity,
  loadRunAgentCredential,
  parseCodexAuth,
  type RunAgentCredential,
} from '../services/run-agent-credential';

export const CODEX_AGENT_TYPE = 'openai-codex';
export const CODEX_CREDENTIAL_KIND = 'oauth-token';

export interface RefreshCandidate {
  credential: RunAgentCredential;
  auth: Record<string, unknown>;
  identity: CodexAuthIdentity;
}

/**
 * Read every candidate credential, skipping rows that are gone, inactive, or
 * unreadable. An inactive candidate is never replaced by another credential
 * (rule 28): a deactivated pin forces re-auth instead of falling back to the
 * user's default account.
 */
export async function loadRefreshCandidates(
  database: D1Database,
  encryptionKey: string,
  userId: string,
  credentialReferences: string[]
): Promise<{ candidates: RefreshCandidate[]; readFailure: string | null }> {
  let readFailure: string | null = null;
  const loaded = await Promise.all(
    credentialReferences.map(async (reference): Promise<RefreshCandidate | null> => {
      const credential = await loadRunAgentCredential(database, {
        userId,
        reference,
        agentType: CODEX_AGENT_TYPE,
        credentialKind: CODEX_CREDENTIAL_KIND,
      });
      if (!credential) {
        log.warn('codex_refresh.credential_not_found', {
          userId,
          credentialReference: reference,
        });
        return null;
      }
      if (!credential.isActive) {
        log.warn('codex_refresh.inactive_credential_no_fallback', {
          userId,
          credentialReference: reference,
        });
        return null;
      }
      let decrypted: string;
      try {
        decrypted = await decrypt(credential.encryptedToken, credential.iv, encryptionKey);
      } catch {
        readFailure ??= 'Failed to decrypt stored credential';
        log.error('codex_refresh.credential_decrypt_failed', {
          userId,
          credentialReference: reference,
        });
        return null;
      }
      const parsed = parseCodexAuth(decrypted);
      if (!parsed) {
        readFailure ??= 'Stored credential is not valid JSON';
        log.error('codex_refresh.credential_not_json', {
          userId,
          credentialReference: reference,
        });
        return null;
      }
      return { credential, auth: parsed.auth, identity: parsed.identity };
    })
  );
  const candidates = loaded.filter((c): c is RefreshCandidate => c !== null);
  return { candidates, readFailure };
}

/**
 * Read an upstream (OpenAI) refresh error, keeping only the safe fields: the
 * flat OAuth2 `{ error, error_description }` form and the nested
 * `{ error: { code, message } }` form. The raw body is never returned or logged,
 * so an echoed refresh token cannot leak.
 */
export async function readSafeUpstreamError(upstreamResponse: Response): Promise<{
  safeError: Record<string, string>;
  upstreamErrorCode: string | null;
  upstreamErrorMessage: string | null;
}> {
  // Parse and filter upstream error — only forward safe fields to prevent
  // information leakage (e.g., if OpenAI echoes back the refresh token).
  // OpenAI returns errors in TWO shapes: the flat OAuth2 form
  // `{ error, error_description }` and a nested form
  // `{ error: { code, message, type } }`. Parse both so the structured
  // diagnostic captures the rejection reason (e.g. `refresh_token_invalidated`,
  // which means the stored token was revoked at OpenAI — log out / re-login /
  // a sibling refresh consumed it — versus a transient upstream fault).
  const safeError: Record<string, string> = { error: 'upstream_error' };
  let upstreamErrorCode: string | null = null;
  let upstreamErrorMessage: string | null = null;
  let rawBody = '';
  try {
    rawBody = await upstreamResponse.text();
  } catch {
    // Body unreadable — leave rawBody empty.
  }
  try {
    const parsedRaw = JSON.parse(rawBody) as unknown;
    const parsed = maybeJsonRecord(parsedRaw);
    if (parsed && typeof parsed.error === 'string') {
      // Flat OAuth2 form.
      safeError.error = parsed.error;
      upstreamErrorCode = parsed.error;
      if (typeof parsed.error_description === 'string') {
        safeError.error_description = parsed.error_description;
        upstreamErrorMessage = parsed.error_description;
      }
    } else if (parsed && parsed.error && typeof parsed.error === 'object') {
      // OpenAI nested form: { error: { code, message, type } }.
      const nested = maybeJsonRecord(parsed.error);
      if (nested) {
        if (typeof nested.code === 'string') {
          safeError.error = nested.code;
          upstreamErrorCode = nested.code;
        }
        if (typeof nested.message === 'string') {
          safeError.error_description = nested.message;
          upstreamErrorMessage = nested.message;
        }
      }
    }
  } catch {
    // Non-JSON upstream response — use generic error.
  }
  return { safeError, upstreamErrorCode, upstreamErrorMessage };
}
