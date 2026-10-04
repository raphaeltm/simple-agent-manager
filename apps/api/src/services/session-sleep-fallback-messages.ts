/**
 * What SAM tells the user, and the woken agent, about a bounded sleep fallback.
 *
 * The wording is deliberately literal: it says what was kept, what was not, and never
 * promises an exact reconstruction. System messages render as preformatted text in the
 * chat (`SystemMessageBubble`), so these are plain text, not Markdown.
 */
import type {
  SessionSleepBlockedReason,
  SessionSleepFallbackRecord,
} from './session-sleep-episode';

const SHORT_COMMIT_LENGTH = 12;

function shortCommit(commit: string): string {
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

function minutesBetween(fromIso: string | null, toIso: string): number | null {
  const from = Date.parse(fromIso ?? '');
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.max(1, Math.round((to - from) / 60_000));
}

function attemptsSummary(record: SessionSleepFallbackRecord): string {
  const attempts = `${record.failedAttempts} attempt${record.failedAttempts === 1 ? '' : 's'}`;
  const minutes = minutesBetween(record.episodeStartedAt, record.decidedAt);
  return minutes === null
    ? attempts
    : `${attempts} over ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function lastErrorClause(record: SessionSleepFallbackRecord): string {
  return record.lastError ? ` Last error: ${record.lastError}` : '';
}

function capturedClause(capturedAt: string | null): string {
  return capturedAt ? ` (saved ${capturedAt})` : '';
}

function gitLocation(record: SessionSleepFallbackRecord): string {
  const point = record.recoveryPoint;
  if (!point) return 'the saved Git commit';
  const commit = `commit ${shortCommit(point.commit)}`;
  if (point.branch) return `branch ${point.branch} at ${commit}`;
  return point.detached ? `${commit} (detached HEAD)` : commit;
}

/** Deterministic message id, so a replayed sweep or a roll-forward lands the notice once. */
export function sessionSleepNoticeId(
  kind: 'fallback' | 'blocked',
  chatSessionId: string,
  episodeKey: string
): string {
  return `sleep-${kind}-${chatSessionId}-${episodeKey}`;
}

/** The chat notice persisted before a fallback sleep releases the workspace. */
export function sessionSleepFallbackNotice(record: SessionSleepFallbackRecord): string {
  const point = record.recoveryPoint;
  if (!point) throw new Error('A fallback sleep notice needs its recovery point');
  if (point.snapshotStatus === 'available' && point.degradation === 'none') {
    return [
      'SAM put this session to sleep using its last complete snapshot.',
      '',
      `Saving a fresh snapshot failed after ${attemptsSummary(record)}, so SAM released the workspace to stop using compute.${lastErrorClause(record)}`,
      '',
      `Kept: this conversation and the complete snapshot${capturedClause(point.capturedAt)}, including ${gitLocation(record)}.`,
      'Not kept: any change made after that snapshot was saved.',
      '',
      'Send a message to wake it. The agent will check the transcript before continuing.',
    ].join('\n');
  }
  return [
    'SAM put this session to sleep without saving all of its files.',
    '',
    `Saving a complete snapshot failed after ${attemptsSummary(record)}. Sleep should not keep a machine running forever, so SAM released the workspace and kept a recovery point instead.${lastErrorClause(record)}`,
    '',
    'Kept:',
    '- this conversation',
    `- the repository: ${gitLocation(record)}, with its uncommitted changes${capturedClause(point.capturedAt)}`,
    '',
    'Not kept:',
    `- files outside the repository${point.homeSaved ? ' that the snapshot skipped' : ', including installed tools and the agent’s own session files'}`,
    '- any change made after the recovery point was saved',
    '',
    'Send a message to wake it. SAM starts a fresh workspace at that commit, and the agent rebuilds its context from this conversation instead of resuming its old session.',
  ].join('\n');
}

const BLOCKED_REASON_TEXT: Record<SessionSleepBlockedReason, string> = {
  no_git_baseline: 'no saved snapshot records which Git commit the workspace is on',
  commit_objects_unavailable:
    'the saved Git commit was not kept with its objects, so a new workspace may not be able to restore it',
  recovery_point_expired: 'the last saved snapshot has expired',
  unsupported_runtime: 'an Instant workspace can only sleep with a complete snapshot',
  retry_ceiling: 'saving the recovery point kept failing',
};

/** The chat notice persisted when the episode ends without releasing the workspace. */
export function sessionSleepBlockedNotice(
  record: SessionSleepFallbackRecord,
  runtime: string
): string {
  const reason = record.blockedReason ?? 'retry_ceiling';
  const keepsRunning =
    runtime === 'cf-container'
      ? 'This Instant workspace keeps running until you archive the conversation or it reaches its maximum lifetime.'
      : 'Its workspace keeps running.';
  return [
    'SAM could not put this session to sleep.',
    '',
    `Saving a snapshot failed after ${attemptsSummary(record)}, and SAM could not keep a safe recovery point: ${BLOCKED_REASON_TEXT[reason]}.${lastErrorClause(record)}`,
    '',
    `To avoid retrying forever, SAM stopped trying to put this session to sleep automatically. ${keepsRunning}`,
    '',
    'What you can do:',
    '- Keep working: send a message as usual. SAM tries sleep again the next time the session goes idle.',
    '- Or commit and push anything you want to keep, then archive this conversation to release the workspace.',
  ].join('\n');
}

export const SESSION_RECOVERY_INITIAL_PROMPT =
  'Resume this sleeping conversation from the persisted transcript. Use get_session_messages for this chat session before relying on memory. Do not repeat prior work; wait for and answer the latest queued follow-up message.';

/**
 * The first prompt of a wake. After a fallback sleep it tells the agent which files to
 * expect, how to check them, and not to replay effects outside the workspace.
 */
export function sessionRecoveryInitialPrompt(record: SessionSleepFallbackRecord | null): string {
  const point = record?.outcome === 'slept' ? record.recoveryPoint : null;
  if (!point) return SESSION_RECOVERY_INITIAL_PROMPT;
  const complete = point.snapshotStatus === 'available' && point.degradation === 'none';
  const short = shortCommit(point.commit);
  const where = point.branch ? `on branch ${point.branch}` : 'in this repository';
  return [
    'Resume this sleeping conversation from the persisted transcript. Use get_session_messages for this chat session before relying on memory.',
    '',
    complete
      ? `Important: this session slept from its last complete snapshot${capturedClause(point.capturedAt)} because saving a fresh one failed. Changes made after that snapshot are not in this workspace.`
      : `Important: this session slept through SAM's fallback, so its workspace files were not fully saved. SAM restored commit ${point.commit} ${where} with the uncommitted changes from the recovery point${capturedClause(point.capturedAt)}. Files outside the repository, your previous agent session files, and any changes made after that point are gone.`,
    '',
    'Before continuing:',
    `1. Run git status and git log -1 to confirm the workspace is at commit ${short} ${where}. If it is not, tell the user what you found.`,
    '2. Compare the transcript with the files to find work that was lost, and redo only what is missing.',
    '3. Do not repeat actions with effects outside this workspace that the transcript shows already happened, such as pushes, pull requests, deployments, messages, or API calls. If you cannot tell whether one happened, check first or ask the user.',
    '',
    'Then wait for and answer the latest queued follow-up message.',
  ].join('\n');
}
