import assert from 'node:assert/strict';

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
  );
}

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
  if (fixture.agentProfileId) {
    assert(
      candidate.agentProfileId === fixture.agentProfileId && candidate.taskMode === 'conversation',
      'Fixture execution configuration mismatch'
    );
  }
  return candidate.id;
}

/** Project detail intentionally omits githubRepoId; use the OAuth-scoped repository response. */
export function resolveAuditRepository(
  project,
  installations,
  repositories,
  externalInstallationId
) {
  assert(
    project.status === 'active' && project.repoProvider === 'github',
    'Active GitHub project required'
  );
  const installation = installations.find((item) => item.id === project.installationId);
  assert(
    installation && Number(installation.installationId) === externalInstallationId,
    'Fixture installation mismatch'
  );
  const matches = repositories.repositories.filter(
    (item) =>
      item.installationId === project.installationId &&
      item.fullName.toLowerCase() === project.repository.toLowerCase()
  );
  assert(matches.length === 1, 'Existing smoke OAuth principal lacks unique fixture access');
  const repository = matches[0];
  assert(Number.isSafeInteger(repository.id) && repository.id > 0, 'Invalid repository ID');
  return { repository: repository.fullName, repositoryId: repository.id };
}

/** Same signed-cookie sharing contract as tests/smoke/helpers/auth.ts; never log header/value. */
export function smokeSessionCookie(setCookieHeader) {
  const match = setCookieHeader.match(/(__Secure-)?better-auth\.session_token=([^;]+)/);
  assert(match, 'Token login succeeded without signed session cookie');
  let signedValue;
  try {
    signedValue = decodeURIComponent(match[2]);
  } catch {
    throw new Error('Malformed signed session cookie');
  }
  return {
    name: `${match[1] || ''}better-auth.session_token`,
    value: signedValue,
    domain: '.sammy.party',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  };
}

export function hasAuditReply(task, messages, marker) {
  const assistantText = messages
    .filter((item) => item.role === 'assistant' && typeof item.content === 'string')
    .map((item) => item.content)
    .join('');
  return (
    task.status === 'in_progress' &&
    task.executionStep === 'awaiting_followup' &&
    assistantText.includes(marker)
  );
}

export async function readAuditMessages(fetchPage, maxPages = 10) {
  const messages = [];
  let after;
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(after);
    assert(Array.isArray(result.messages), 'Invalid message page');
    messages.push(...result.messages);
    if (!result.hasMore) return messages;
    const last = result.messages.at(-1);
    assert(
      last &&
        Number.isSafeInteger(last.createdAt) &&
        Number.isSafeInteger(last.sequence) &&
        typeof last.id === 'string',
      'Missing exact message cursor'
    );
    const next = JSON.stringify([last.createdAt, last.sequence, last.id]);
    assert(next !== after, 'Message cursor did not advance');
    after = next;
  }
  throw new Error('Audit message inventory incomplete');
}

/** Bounded staging queue/affinity fixtures; no caller-supplied payload or prompt is signed. */
export function auditSignedDeliveryIntents(fixture, targetEnvironment) {
  assert(
    targetEnvironment !== 'production' || !fixture.deliveries,
    'Batch and comment fixtures are staging-only'
  );
  const deliveries = fixture.deliveries ?? [
    { deliveryId: fixture.deliveryId, eventType: 'issues', subjectNumber: 1 },
  ];
  assert(
    Array.isArray(deliveries) && deliveries.length > 0 && deliveries.length <= 2,
    'Use one or two bounded audit deliveries'
  );
  assert(
    new Set(deliveries.map((item) => item.deliveryId)).size === deliveries.length,
    'Batch delivery IDs must be unique'
  );
  return deliveries.map((item, index) => {
    assert(isUuid(item.deliveryId), 'Invalid fixture delivery ID');
    assert(
      ['issues', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'].includes(
        item.eventType
      ),
      'Unsupported audit event'
    );
    assert(
      Number.isSafeInteger(item.subjectNumber) && item.subjectNumber > 0,
      'Invalid audit subject'
    );
    const reviewEvent = item.eventType.startsWith('pull_request_review');
    const contentId = Number.parseInt(item.deliveryId.replaceAll('-', '').slice(0, 12), 16) + 1;
    const user = { login: 'sam-staging-audit', type: 'User' };
    const subjectUrl = `https://github.com/${fixture.repository}/pull/${item.subjectNumber}`;
    return {
      deliveryId: item.deliveryId,
      eventType: item.eventType,
      payload: JSON.stringify({
        action:
          item.eventType === 'issues'
            ? 'opened'
            : item.eventType === 'pull_request_review'
              ? 'submitted'
              : 'created',
        installation: { id: fixture.installationId },
        repository: { id: fixture.repositoryId, full_name: fixture.repository },
        sender: {
          login:
            targetEnvironment === 'production' ? 'simple-agent-manager[bot]' : 'sam-staging-audit',
          type: targetEnvironment === 'production' ? 'Bot' : 'User',
        },
        ...(!reviewEvent
          ? {
              issue: {
                id: item.subjectNumber,
                number: item.subjectNumber,
                title: `${fixture.marker} Résumé 🐙`,
                body: fixture.marker,
                labels: [{ name: fixture.marker }],
                state: 'open',
                ...(item.eventType === 'issue_comment'
                  ? {
                      pull_request: {
                        url: `https://api.github.com/repos/${fixture.repository}/pulls/${item.subjectNumber}`,
                      },
                    }
                  : {}),
              },
            }
          : {
              pull_request: {
                number: item.subjectNumber,
                title: `${fixture.marker} review`,
                html_url: subjectUrl,
                labels: [{ name: fixture.marker }],
                draft: false,
                head: { ref: 'audit-fixture', sha: 'a'.repeat(40) },
                base: { ref: 'main' },
              },
            }),
        ...(reviewEvent
          ? item.eventType === 'pull_request_review'
            ? {
                review: {
                  id: contentId,
                  body: `/sam ${fixture.marker} feedback`,
                  state: 'changes_requested',
                  html_url: `${subjectUrl}#pullrequestreview-${contentId}`,
                  author_association: 'MEMBER',
                  user,
                },
              }
            : {
                comment: {
                  id: contentId,
                  body: `/sam ${fixture.marker} inline`,
                  html_url: `${subjectUrl}#discussion_r${contentId}`,
                  path: 'fixture.ts',
                  line: 7,
                  original_line: 7,
                  author_association: 'MEMBER',
                  user,
                },
              }
          : {}),
        ...(item.eventType === 'issue_comment'
          ? {
              comment: {
                id: Number.parseInt(item.deliveryId.replaceAll('-', '').slice(0, 12), 16) + 1,
                body: `/sam ${fixture.marker} comment ${index + 1}`,
              },
            }
          : {}),
      }),
    };
  });
}

export function validateAuditFixture(fixture) {
  assert(/^github-trigger-audit-[a-f0-9-]{36}$/.test(fixture.marker), 'Invalid fixture marker');
  assert(isUuid(fixture.deliveryId), 'Invalid fixture delivery ID');
  assert(
    /^[0-9A-Z]{26}$/.test(fixture.projectId) && /^[0-9A-Z]{26}$/.test(fixture.triggerId),
    'Invalid fixture IDs'
  );
  assert(/^[\w.-]+\/[\w.-]+$/.test(fixture.repository), 'Invalid repository name');
  assert(
    Number.isSafeInteger(fixture.repositoryId) && fixture.repositoryId > 0,
    'Invalid repository ID'
  );
  assert(
    Number.isSafeInteger(fixture.installationId) && fixture.installationId > 0,
    'Invalid installation ID'
  );
}
