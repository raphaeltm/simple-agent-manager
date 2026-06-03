import { describe, expect, it, vi } from 'vitest';

import { resolveTaskAgentProfileHints } from '../../../src/services/agent-profile-display';

function makeProfileQuery(rows: Array<{ id: string; name: string }>) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

describe('agent profile display resolution', () => {
  it('batches profile ID lookups to stay within D1 parameter limits', async () => {
    const select = vi
      .fn()
      .mockReturnValueOnce(makeProfileQuery([{ id: 'profile-000', name: 'First Profile' }]))
      .mockReturnValueOnce(makeProfileQuery([{ id: 'profile-080', name: 'Last Profile' }]));
    const db = { select };
    const hints = Array.from({ length: 81 }, (_, index) => `profile-${String(index).padStart(3, '0')}`);

    const resolved = await resolveTaskAgentProfileHints(db as never, {
      hints,
      projectId: 'proj-1',
      userId: 'user-1',
    });

    expect(select).toHaveBeenCalledTimes(2);
    expect(resolved.get('profile-000')).toBe('First Profile');
    expect(resolved.get('profile-080')).toBe('Last Profile');
  });
});
