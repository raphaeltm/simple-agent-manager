import { describe, expect, it } from 'vitest';

import type { StoredOperationsApproval } from '../../../src/services/operations-actions/approvals';
import { buildOperationsDecisionPrompt } from '../../../src/services/operations-actions/decision-delivery';

function approval(status: StoredOperationsApproval['status']): StoredOperationsApproval {
  return {
    id: 'appr-1',
    action: 'restart_vm_agent',
    targetId: 'node-1',
    status,
    decisionNote: null,
    expiresAt: '2026-11-08T03:00:00.000Z',
  } as StoredOperationsApproval;
}

describe('buildOperationsDecisionPrompt', () => {
  it('tells the agent an approval it already ran must not run again', () => {
    const prompt = buildOperationsDecisionPrompt(approval('executed'));
    expect(prompt).toMatch(/^Operations action approved and already run: restart_vm_agent/);
    expect(prompt).toContain('Do not run it again.');
    expect(prompt).not.toMatch(/denied/i);
  });

  it('still tells the agent to run an approved action once, and not to run a denied one', () => {
    expect(buildOperationsDecisionPrompt(approval('approved'))).toMatch(
      /^Operations action approved: .*\nRun it once with ops_execute_action/
    );
    expect(buildOperationsDecisionPrompt(approval('denied'))).toMatch(
      /^Operations action denied: .*Do not run it\./
    );
  });
});
