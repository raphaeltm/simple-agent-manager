import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../../src/failure-classification';

describe('classifyFailure', () => {
  it.each([
    ['cancelled', 'Task was cancelled by the user'],
    ['capacity', 'Cloud provider reported server limit reached'],
    ['credentials', 'Authentication failed: token expired'],
    ['provider-overload', 'Provider returned 529 overloaded'],
    ['agent-install', 'Codex installation failed in the workspace'],
    ['provisioning', 'Workspace creation timed out'],
    ['prompt-timeout', 'ACP_TASK_PROMPT_TIMEOUT exceeded'],
    ['runtime-lost', 'Container died and runtime recovery exhausted'],
    ['agent-crash', 'Agent process crashed with SIGKILL'],
    ['stalled', 'Task stuck in running beyond watchdog threshold'],
    ['network', 'fetch failed with ECONNREFUSED'],
  ] as const)('classifies %s failures', (code, message) => {
    expect(classifyFailure(message)).toMatchObject({ code, retryable: true });
  });

  // Verbatim production reconciliation-sweep messages — the most common
  // terminal failure reasons observed in the live databases. Pinned so the
  // classifier can never regress them back to `unknown`.
  it.each([
    'Task runtime is conclusively gone after reconciliation grace (workspace_missing)',
    'Task runtime is no longer live after 240 minutes. Last liveness result: workspace_missing',
  ])('classifies real reconciliation-sweep messages as runtime-lost: %s', (message) => {
    expect(classifyFailure(message).code).toBe('runtime-lost');
  });

  it('uses the optional execution step as classification evidence', () => {
    expect(classifyFailure('Operation failed', 'node provisioning timed out').code).toBe(
      'provisioning'
    );
  });

  it('uses first-match-wins ordering when a message matches multiple rules', () => {
    expect(classifyFailure('Task cancelled after provider returned 503 overloaded').code).toBe(
      'cancelled'
    );
    expect(classifyFailure('Unauthorized request was also rate limited with 429').code).toBe(
      'credentials'
    );
  });

  it.each([undefined, null, '', 'an entirely novel failure mode'])(
    'falls back to unknown for unclassified input %s',
    (message) => {
      expect(classifyFailure(message)).toEqual({
        code: 'unknown',
        label: 'Failed',
        explanation: 'The task failed for a reason SAM could not automatically classify.',
        guidance:
          'Read the error details below. Copy the debug report and paste it to an agent to investigate.',
        retryable: true,
      });
    }
  );
});
