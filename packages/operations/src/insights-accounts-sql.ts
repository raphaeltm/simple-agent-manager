/**
 * The D1 statements behind `projectAccounts` (`insights-accounts.ts`). Every statement binds the
 * project on every table it reads, and every join carries the project too (directly, or through a
 * project-scoped workspace), so a row from another project can never reach a count (rule 11;
 * tested against a real SQL engine with a foreign-project fixture).
 *
 * Account identity columns, the same in every statement (`ACCOUNT_COLUMNS`):
 * - `ref`: the run's credential reference, or a limit key (`credentialLimitReferenceKey`) where
 *   only the key was stored;
 * - `source`, `agent_type`: as the agent session or limit window recorded them;
 * - `kind`: the credential's kind (`cc_credentials.kind`), visible to every member;
 * - `cred_own`: 1 when the viewer owns the credential, 0 when someone else does, null when the
 *   credential row is gone or the reference is not a composable credential;
 * - `session_own`: 1 when the viewer ran the session (or reported the window);
 * - `own_name`: the credential's name, only when the viewer owns it. Another member's credential
 *   name never leaves the database (`routes/chat-agent-credential.ts`). The token columns are
 *   never selected.
 */
import { CREDENTIAL_REFERENCE_DIGEST_KEY_BYTES } from '@simple-agent-manager/shared';

import type { FlowStatement, FlowWindow } from './insights-flow-sql';
import { runsCte } from './insights-flow-sql';

/** `cc_credentials:` prefix length plus one: `substr(ref, 16)` is the credential id. */
const CC_ID_FROM = 'cc_credentials:'.length + 1;

/** Join one credential row by the id inside a `cc_credentials:<id>` reference or key. */
function credentialJoin(refExpr: string): string {
  return `LEFT JOIN cc_credentials c
    ON ${refExpr} LIKE 'cc_credentials:%' AND c.id = substr(${refExpr}, ${CC_ID_FROM})`;
}

/** Binds: viewer ×2. */
const CREDENTIAL_COLUMNS = `c.kind AS kind,
       CASE WHEN c.id IS NULL THEN NULL WHEN c.owner_id = ? THEN 1 ELSE 0 END AS cred_own,
       CASE WHEN c.owner_id = ? THEN c.name END AS own_name`;

/**
 * Runs per account per day: Flow's run population (`runsCte`), each run counted on the day it
 * ended, or the day it started while it is still going. Binds: `runsCte` (7), viewer ×3.
 */
export function accountRunsStatement(w: FlowWindow, viewerId: string): FlowStatement {
  return {
    sql: `${runsCte({ account: true })}
    SELECT r.account_ref AS ref, r.account_source AS source, r.account_agent_type AS agent_type,
           ${CREDENTIAL_COLUMNS},
           max(r.account_user = ?) AS session_own,
           CASE WHEN r.running = 1 THEN r.started_day ELSE r.ended_day END AS day,
           count(*) AS runs, sum(r.pr_rank = 3) AS merged
      FROM runs r
      ${credentialJoin('r.account_ref')}
     GROUP BY r.account_ref, r.account_source, r.account_agent_type, day`,
    binds: [
      w.projectId,
      w.projectId,
      w.since,
      w.since,
      w.projectId,
      w.projectId,
      w.projectId,
      viewerId,
      viewerId,
      viewerId,
    ],
  };
}

const WAIT_JSON = `CASE WHEN json_valid(t.provider_limit_wait_json) THEN t.provider_limit_wait_json ELSE '{}' END`;

/**
 * The newest usage-limit waits that began in the range, at most `cap` (+1 to tell whether the cap
 * cut the list short). A task keeps only its latest wait (`tasks.provider_limit_wait_json`);
 * `origin` says whether it paused mid-run (`callback`) or was held before starting
 * (`admission`, the `provider_limit_waiting` admission state). The session that hit the limit,
 * when the wait recorded one, supplies the account's source and agent; it must belong to a
 * workspace of this project. Binds: viewer ×3, project, since (ms), cap + 1.
 */
export function stallWaitsStatement(w: FlowWindow, viewerId: string, cap: number): FlowStatement {
  return {
    sql: `SELECT t.id AS task_id, t.status, t.completed_at, t.updated_at, t.admission_state,
           t.provider_limit_wait_json AS wait_json,
           json_extract(${WAIT_JSON}, '$.credentialKey') AS ref,
           s.agent_credential_source AS source, s.agent_type AS agent_type,
           ${CREDENTIAL_COLUMNS},
           s.user_id = ? AS session_own
      FROM tasks t
      LEFT JOIN agent_sessions s
        ON s.id = json_extract(${WAIT_JSON}, '$.sourceAgentSessionId')
       AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = s.workspace_id AND w.project_id = t.project_id)
      ${credentialJoin(`json_extract(${WAIT_JSON}, '$.credentialKey')`)}
     WHERE t.project_id = ? AND t.provider_limit_wait_json IS NOT NULL
       AND json_extract(${WAIT_JSON}, '$.observedAt') >= ?
     ORDER BY json_extract(${WAIT_JSON}, '$.observedAt') DESC, t.id DESC
     LIMIT ?`,
    binds: [viewerId, viewerId, viewerId, w.projectId, w.sinceMs, cap + 1],
  };
}

/**
 * Limit windows the provider reported as rejected, observed in the range. One row per project ×
 * credential × window, holding only the latest sample, so a rejection a later allowed sample
 * replaced is gone (the task waits above still carry it). Like the project's limit read
 * (`listProjectCredentialLimits`), another member's personal-credential windows are left out:
 * only the viewer's own and shared project or platform ones. Binds: viewer ×3, project, viewer,
 * since (ms), cap + 1.
 */
export function rejectedWindowsStatement(
  w: FlowWindow,
  viewerId: string,
  cap: number
): FlowStatement {
  return {
    sql: `SELECT l.credential_reference AS ref, l.credential_source AS source, l.agent_type AS agent_type,
           ${CREDENTIAL_COLUMNS},
           l.user_id = ? AS session_own,
           l.window_type, l.window_minutes, l.observed_at, l.resets_at
      FROM credential_limit_windows l
      ${credentialJoin('l.credential_reference')}
     WHERE l.project_id = ? AND (l.user_id = ? OR l.credential_source IN ('project', 'platform'))
       AND l.status = 'rejected' AND l.observed_at >= ?
     ORDER BY l.observed_at DESC, l.credential_reference, l.window_type
     LIMIT ?`,
    binds: [viewerId, viewerId, viewerId, w.projectId, viewerId, w.sinceMs, cap + 1],
  };
}

/**
 * The viewer's own credentials whose reference is longer than a limit key, so the limit writers
 * store it as a `sha256:` digest that `credentialJoin` cannot match (ids from the 2026-06
 * composable-credentials backfill). The operation hashes these to recognise the viewer's own
 * account in waits and windows that carry only the digest. Never another member's rows, never the
 * token columns. Binds: viewer, the reference length a digest key replaces.
 */
export function ownLongCredentialsStatement(viewerId: string): FlowStatement {
  return {
    sql: `SELECT id, name, kind FROM cc_credentials
           WHERE owner_id = ? AND length('cc_credentials:' || id) > ?`,
    binds: [viewerId, CREDENTIAL_REFERENCE_DIGEST_KEY_BYTES],
  };
}
