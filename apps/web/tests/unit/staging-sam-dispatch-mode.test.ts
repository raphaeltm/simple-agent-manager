import { describe, expect, it } from 'vitest';

import { hasConversationDispatchMode } from '../playwright/staging-sam-dispatch-evidence';

const profile = { id: 'verified-profile', taskMode: 'conversation' };
describe('dispatch conversation mode evidence', () => {
  it('accepts an omitted optional mode from the exact persisted conversation profile', () => {
    expect(hasConversationDispatchMode({ agentProfileId: profile.id }, profile)).toBe(true);
  });
  it('accepts an explicit conversation mode for the exact selected profile', () => {
    expect(
      hasConversationDispatchMode({ agentProfileId: profile.id, taskMode: 'conversation' }, profile)
    ).toBe(true);
  });
  it.each(['task', null, '', 'unknown'])('rejects an incompatible explicit mode %s', (taskMode) => {
    expect(hasConversationDispatchMode({ agentProfileId: profile.id, taskMode }, profile)).toBe(
      false
    );
  });
  it.each(['task', undefined, null])(
    'rejects omission without verified conversation profile mode %s',
    (taskMode) => {
      expect(
        hasConversationDispatchMode({ agentProfileId: profile.id }, { ...profile, taskMode })
      ).toBe(false);
    }
  );
  it.each(['other-profile', undefined, null])(
    'rejects a missing or different profile identity %s',
    (agentProfileId) => {
      expect(hasConversationDispatchMode({ agentProfileId }, profile)).toBe(false);
    }
  );
  it('rejects two missing profile identities rather than treating them as a match', () => {
    expect(hasConversationDispatchMode({}, { taskMode: 'conversation' })).toBe(false);
  });
});
