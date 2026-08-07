/**
 * Failure classification for task/session/agent errors.
 *
 * SAM stores failure reasons as free text (`tasks.error_message`,
 * `task_status_events.reason`, platform error messages). This module maps that
 * free text onto a small stable taxonomy so UI surfaces can show users WHAT
 * kind of failure happened and WHAT to do next, without a schema migration.
 *
 * Classification is display-time only: it must never gate behavior on the
 * server. Rules are ordered — first match wins — and the fallback is `unknown`.
 */

export type FailureCode =
  | 'cancelled'
  | 'capacity'
  | 'provisioning'
  | 'agent-install'
  | 'credentials'
  | 'provider-overload'
  | 'prompt-timeout'
  | 'agent-crash'
  | 'runtime-lost'
  | 'stalled'
  | 'network'
  | 'unknown';

export interface FailureClassification {
  code: FailureCode;
  /** Short human label, e.g. "Cloud capacity" */
  label: string;
  /** One-sentence plain-language explanation of what this failure class means. */
  explanation: string;
  /** Concrete next step the user can take. */
  guidance: string;
  /** Whether retrying the same task/session is likely to help. */
  retryable: boolean;
}

interface FailureRule {
  code: FailureCode;
  label: string;
  explanation: string;
  guidance: string;
  retryable: boolean;
  patterns: RegExp[];
}

/**
 * Ordered rules — first match wins. Patterns are matched against the combined
 * lowercase `message` + `step` text. Keep patterns conservative: a wrong
 * classification is worse than `unknown`.
 */
const FAILURE_RULES: FailureRule[] = [
  {
    code: 'cancelled',
    label: 'Cancelled',
    explanation: 'The task was stopped intentionally by a user or a parent agent.',
    guidance: 'No action needed. Start a new task or retry if this was unintended.',
    retryable: true,
    patterns: [/\bcancell?ed\b/, /stopped by (the )?(user|parent|orchestrator)/, /stop_subtask/],
  },
  {
    code: 'capacity',
    label: 'Cloud capacity',
    explanation: 'The cloud provider refused to create a VM because an account or datacenter limit was reached.',
    guidance: 'Free unused nodes or wait for capacity, then retry. Admins can check provider limits.',
    retryable: true,
    patterns: [
      /server limit reached/,
      /resource_unavailable/,
      /\bquota\b.*(exceeded|reached|limit)/,
      /(exceeded|reached).*\bquota\b/,
      /out of capacity/,
      /placement.*(failed|exhausted)/,
    ],
  },
  {
    code: 'credentials',
    label: 'Credentials / billing',
    explanation: 'An API key, OAuth token, or account balance problem stopped the agent.',
    guidance: 'Check the agent credential in Settings (API key validity, OAuth login, or provider credit balance), then retry.',
    retryable: true,
    patterns: [
      /credit balance/,
      /insufficient (credit|funds|quota)/,
      /invalid (api key|x-api-key|token|credential)/,
      /(authentication|authorization) (failed|error)/,
      /\bunauthorized\b/,
      /\b401\b/,
      /token (expired|revoked|invalid)/,
      /refresh token/,
      /billing/,
    ],
  },
  {
    code: 'provider-overload',
    label: 'Provider overloaded',
    explanation: 'The LLM provider was temporarily overloaded or rate-limited the request.',
    guidance: 'This is usually transient. Wait a few minutes and retry.',
    retryable: true,
    patterns: [
      /\boverloaded\b/,
      /rate.?limit/,
      /\b429\b/,
      /\b529\b/,
      /\b503\b/,
      /temporarily unavailable/,
      /too many requests/,
    ],
  },
  {
    code: 'agent-install',
    label: 'Agent install failed',
    explanation: 'The coding agent could not be installed inside the workspace.',
    guidance: 'Retry the task. If it persists, check the node network/debug package or try a different agent type.',
    retryable: true,
    patterns: [
      /(install|installation).*(agent|claude|codex|gemini|opencode|amp)/,
      /(agent|claude|codex|gemini|opencode|amp).*(install|installation) (failed|error|timed out)/,
      /npm (install|error).*(agent|-g)/,
    ],
  },
  {
    code: 'provisioning',
    label: 'Provisioning failed',
    explanation: 'The workspace or VM did not finish starting up.',
    guidance: 'Retry the task — a fresh node will be provisioned. If it repeats, check the node debug package or provider status.',
    retryable: true,
    patterns: [
      /provision(ing)? (failed|error|timed? ?out)/,
      /node provisioning may have failed/,
      /workspace may have failed to start/,
      /devcontainer.*(build|up).*(failed|timed? ?out)/,
      /cloud-init/,
      /no (available|eligible) node/,
      /workspace (creation|create) (failed|timed out)/,
      /failed to (create|start) workspace/,
    ],
  },
  {
    code: 'prompt-timeout',
    label: 'Prompt timed out',
    explanation: 'The agent ran a single turn longer than the allowed time and was force-stopped.',
    guidance: 'Break the work into smaller prompts, or retry. Long orchestration should report progress between turns.',
    retryable: true,
    patterns: [/prompt.*(timed? ?out|force.?stopped)/, /force.?stopped.*prompt/, /acp_task_prompt_timeout/],
  },
  {
    code: 'runtime-lost',
    label: 'Runtime lost',
    explanation: 'The container or VM running the agent died and automatic recovery could not restore it.',
    guidance: 'Your chat history is preserved. Send a follow-up message to resume on a fresh runtime, or retry the task.',
    retryable: true,
    patterns: [
      /runtime recovery exhausted/,
      /instant runtime recovery/,
      /container (exited|died|not found|stopped unexpectedly)/,
      /node (became )?(unreachable|unhealthy|stale)/,
      /heartbeat (lost|timed? ?out|stale)/,
      /workspace (was |has been )?(deleted|destroyed|removed)/,
      // Reconciliation sweep terminal messages (verified verbatim in production)
      /runtime is (conclusively gone|no longer live)/,
      /workspace_missing/,
    ],
  },
  {
    code: 'agent-crash',
    label: 'Agent crashed',
    explanation: 'The agent process exited unexpectedly while working.',
    guidance: 'SAM usually recovers crashed sessions automatically. If it did not, send a follow-up message or retry.',
    retryable: true,
    patterns: [
      /peer disconnected/,
      /process (exited|crashed|terminated)/,
      /agent (process )?(crashed|exited|died)/,
      /\bsigkill\b|\bsigsegv\b|\boom\b|out of memory/,
      /broken pipe/,
      /\bepipe\b|\beconnreset\b/,
    ],
  },
  {
    code: 'stalled',
    label: 'Stalled',
    explanation: 'The task stopped making progress and was terminated by the platform watchdog.',
    guidance: 'Retry the task. If this repeats, check whether the agent was waiting on something (input, network, a long tool call).',
    retryable: true,
    patterns: [/task stuck in/, /\bstuck\b.*(threshold|timeout)/, /no (progress|activity|output) (for|since)/, /watchdog/],
  },
  {
    code: 'network',
    label: 'Network error',
    explanation: 'A network problem interrupted communication between SAM and the workspace or provider.',
    guidance: 'Usually transient — retry. If it persists, check the node status page.',
    retryable: true,
    patterns: [
      /\betimedout\b|\beconnrefused\b|\benotfound\b/,
      /network (error|failure|unreachable)/,
      /fetch failed/,
      /request timed out/,
      /\btls\b.*(handshake|certificate)/,
      /dns (error|failure|resolution)/,
    ],
  },
];

const UNKNOWN_CLASSIFICATION: FailureClassification = {
  code: 'unknown',
  label: 'Failed',
  explanation: 'The task failed for a reason SAM could not automatically classify.',
  guidance: 'Read the error details below. Copy the debug report and paste it to an agent to investigate.',
  retryable: true,
};

/**
 * Classify a failure from its free-text message (and optional execution step).
 * Returns a stable classification; falls back to `unknown` when no rule matches.
 */
export function classifyFailure(
  message: string | null | undefined,
  step?: string | null
): FailureClassification {
  const haystack = `${message ?? ''} ${step ?? ''}`.toLowerCase();
  if (!haystack.trim()) {
    return UNKNOWN_CLASSIFICATION;
  }
  for (const rule of FAILURE_RULES) {
    if (rule.patterns.some((p) => p.test(haystack))) {
      return {
        code: rule.code,
        label: rule.label,
        explanation: rule.explanation,
        guidance: rule.guidance,
        retryable: rule.retryable,
      };
    }
  }
  return UNKNOWN_CLASSIFICATION;
}
