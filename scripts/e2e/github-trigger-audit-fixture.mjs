import assert from 'node:assert/strict';

export function auditPrompt(marker) {
  return `This is an authorized staging smoke test. Reply exactly ${marker}. Do not use tools, modify files, create tasks, or write to GitHub or external services. Input: {{github.title}}`;
}

/** Never infer cleanup ownership from an operator-supplied trigger ID alone. */
export function findOwnedAuditTrigger(fixture, triggers) {
  const matches = triggers.filter((item) => item.name === fixture.marker);
  assert(matches.length <= 1, 'Unexpected duplicate fixture marker');
  const candidate = matches[0];
  if (!candidate) {
    assert(!fixture.triggerId, 'Audit trigger marker not found');
    return undefined;
  }
  assert(
    !fixture.triggerId || fixture.triggerId === candidate.id,
    'Fixture trigger ID/marker mismatch'
  );
  assert(
    candidate.sourceType === 'github' && candidate.githubConfig?.eventType === 'issues',
    'Fixture trigger source mismatch'
  );
  const filters = candidate.githubConfig.filters;
  assert.deepEqual(filters.actions, ['opened'], 'Fixture actions mismatch');
  assert.deepEqual(filters.labels, [fixture.marker], 'Fixture labels mismatch');
  assert(filters.bodyContains === fixture.marker, 'Fixture body filter mismatch');
  assert(
    candidate.promptTemplate === auditPrompt(fixture.marker),
    'Fixture prompt ownership mismatch'
  );
  return candidate.id;
}
