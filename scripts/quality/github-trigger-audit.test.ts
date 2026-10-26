import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  auditPrompt,
  findOwnedAuditTrigger,
  hasAuditReply,
  readAuditMessages,
  resolveAuditRepository,
  smokeSessionCookie,
} from '../e2e/github-trigger-audit-fixture.mjs';

const root = resolve(import.meta.dirname, '../..');
const fixture = {
  marker: 'github-trigger-audit-12345678-1234-1234-1234-123456789abc',
  deliveryId: '12345678-1234-1234-1234-123456789abc',
  projectId: '01KP5SJ5XZFZFZCQM8YG5H847V',
  triggerId: '01KP5SJ5XZFZFZCQM8YG5H847W',
  repository: 'test/repo',
  repositoryId: 9876,
  installationId: 12345,
};
const ephemeralKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();
const mock = `
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
let sent = 0;
const fixture = JSON.parse(process.env.GITHUB_TRIGGER_AUDIT_FIXTURE);
globalThis.fetch = async (url, options) => {
  assert(options.signal instanceof AbortSignal);
  assert(options.redirect === 'error');
  if (url === 'https://api.github.com/app') {
    assert(options.headers.Authorization.startsWith('Bearer '));
    assert(options.headers['X-GitHub-Api-Version'] === '2026-03-10');
    if (process.env.TEST_VARIANT === 'metadata-failure') throw new Error(process.env.GH_APP_PRIVATE_KEY);
    return new Response(JSON.stringify({ slug: 'test-app', events: ['issues','issue_comment','pull_request','push'], permissions: { issues: 'write', contents: 'read' }, privateCanary: 'PRIVATE_METADATA_CANARY' }));
  }
  if (url === 'https://api.github.com/app/installations/' + fixture.installationId) return new Response(JSON.stringify({ permissions: { issues: 'write' }, repository_selection: 'selected', suspended_at: null, account: { privateCanary: 'PRIVATE_METADATA_CANARY' } }));
  if (url === 'https://api.github.com/app/hook/config') return new Response(JSON.stringify({ content_type: process.env.TEST_VARIANT === 'hook-content' ? 'form' : 'json', insecure_ssl: process.env.TEST_VARIANT === 'hook-tls' ? '1' : '0', url: (process.env.GITHUB_TRIGGER_AUDIT_ENVIRONMENT === 'production' ? 'https://api.example.test' : 'https://api.sammy.party') + '/api/github/webhook' + (process.env.TEST_VARIANT === 'hook-destination' ? '?secret=PRIVATE_METADATA_CANARY' : ''), secret: 'PRIVATE_METADATA_CANARY' }));
  assert(url === 'https://api.sammy.party/api/github/webhook' || url === 'https://api.example.test/api/github/webhook');
  assert(options.method === 'POST');
  const delivery=(fixture.deliveries || [{deliveryId:fixture.deliveryId,eventType:'issues',subjectNumber:1}]).find(item=>item.deliveryId===options.headers['X-GitHub-Delivery']);
  assert(delivery);
  assert(options.headers['X-GitHub-Event']===delivery.eventType);
  assert(options.headers['X-Hub-Signature-256'] === 'sha256=' + createHmac('sha256', process.env.GH_WEBHOOK_SECRET).update(options.body).digest('hex'));
  const body = JSON.parse(options.body);
  if(delivery.eventType.startsWith('pull_request_review')) {
    assert(!body.issue && body.pull_request.number===delivery.subjectNumber);
    assert(body.pull_request.labels[0].name===fixture.marker);
    const content=body.review || body.comment;
    assert(content.user.login===body.sender.login && content.author_association==='MEMBER');
    assert(content.body.startsWith('/sam '+fixture.marker) && Number.isSafeInteger(content.id));
    if(body.review) assert(body.action==='submitted' && content.state==='changes_requested');
    else assert(body.action==='created' && content.path==='fixture.ts' && content.line===7);
  } else assert(body.action === (delivery.eventType==='issues'?'opened':'created') && body.issue.body === fixture.marker && body.issue.number===delivery.subjectNumber);
  if(delivery.eventType==='issue_comment') { assert(body.comment.body.startsWith('/sam '+fixture.marker)); assert(body.issue.pull_request.url.includes('/pulls/'+delivery.subjectNumber)); assert(Number.isSafeInteger(body.comment.id) && body.comment.id > 0); }
  assert(body.sender.login === (process.env.GITHUB_TRIGGER_AUDIT_ENVIRONMENT === 'production' ? 'simple-agent-manager[bot]' : 'sam-staging-audit'));
  sent++;
  if (process.env.TEST_VARIANT === 'send-failure') throw new Error(options.headers['X-Hub-Signature-256']);
  return new Response('{}');
};
process.on('exit', () => {
  if (!process.env.TEST_VARIANT) assert(sent === 2*(fixture.deliveries?.length || 1));
  if (['metadata-failure', 'hook-content', 'hook-tls', 'hook-destination'].includes(process.env.TEST_VARIANT)) assert(sent === 0);
});
`;
function run(overrides: Record<string, string> = {}) {
  return execFileSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript;base64,${Buffer.from(mock).toString('base64')}`,
      'scripts/e2e/github-trigger-staging.mjs',
      '--phase=send',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SMOKE_TEST_API_URL: 'https://api.sammy.party',
        GH_WEBHOOK_SECRET: 'SIGNING_KEY_CANARY',
        GH_APP_ID: '123',
        GH_APP_PRIVATE_KEY: ephemeralKey,
        GITHUB_TRIGGER_AUDIT_FIXTURE: JSON.stringify(fixture),
        ...overrides,
      },
    }
  );
}
function assertRedacted(output: string) {
  expect(output).not.toContain('SIGNING_KEY_CANARY');
  expect(output).not.toContain('PRIVATE_METADATA_CANARY');
  expect(output).not.toContain('PRIVATE KEY');
  expect(output).not.toContain('sha256=');
  expect(output).not.toContain('Bearer ');
}
describe('bounded GitHub audit signer', () => {
  it('signs two fixed realistic deliveries and emits allowlisted App metadata without credentials', () => {
    const output = run();
    expect(output).toContain('githubAppMetadata');
    expect(output).toContain('syntheticSignedDelivery');
    assertRedacted(output);
  });
  it.each(['issues', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'])(
    'signs at most two simultaneous %s fixtures, each with a stable duplicate replay',
    (eventType) => {
      const output = run({
        GITHUB_TRIGGER_AUDIT_FIXTURE: JSON.stringify({
          ...fixture,
          deliveries: [
            { deliveryId: fixture.deliveryId, eventType, subjectNumber: 7 },
            {
              deliveryId: '22345678-1234-1234-1234-123456789abc',
              eventType,
              subjectNumber: eventType === 'issues' ? 8 : 7,
            },
          ],
        }),
      });
      expect(output.match(/syntheticSignedDelivery/g)).toHaveLength(4);
      assertRedacted(output);
    }
  );
  it('rejects custom batch/comment fixtures in production', () => {
    expect(() =>
      run({
        GITHUB_TRIGGER_AUDIT_ENVIRONMENT: 'production',
        SMOKE_TEST_API_URL: 'https://api.example.test',
        BASE_DOMAIN: 'example.test',
        GITHUB_TRIGGER_AUDIT_FIXTURE: JSON.stringify({
          ...fixture,
          deliveries: [
            { deliveryId: fixture.deliveryId, eventType: 'issue_comment', subjectNumber: 7 },
          ],
        }),
      })
    ).toThrow();
  });
  it('uses the bot actor only on the approved production origin', () => {
    const output = run({
      GITHUB_TRIGGER_AUDIT_ENVIRONMENT: 'production',
      SMOKE_TEST_API_URL: 'https://api.example.test',
      BASE_DOMAIN: 'example.test',
    });
    assertRedacted(output);
  });
  it.each(['metadata-failure', 'send-failure', 'hook-content', 'hook-tls', 'hook-destination'])(
    'suppresses sensitive errors for %s and fails',
    (variant) => {
      try {
        run({ TEST_VARIANT: variant });
        expect.fail('Expected failure');
      } catch (error) {
        const failure = error as { stdout: string; stderr: string; status: number };
        expect(failure.status).toBe(1);
        assertRedacted(`${failure.stdout}${failure.stderr}`);
      }
    }
  );
  it('rejects fixture content outside the minimal marker contract before signing', () => {
    expect(() =>
      run({
        GITHUB_TRIGGER_AUDIT_FIXTURE: JSON.stringify({
          ...fixture,
          marker: 'arbitrary private content',
        }),
      })
    ).toThrow();
  });
  it('rejects a destination outside the trusted staging origin', () => {
    expect(() => run({ SMOKE_TEST_API_URL: 'https://attacker.example.test' })).toThrow();
  });
});

describe('audit workflow isolation', () => {
  for (const path of ['github-trigger-production-audit.yml', 'deploy-staging.yml']) {
    it(`${path} keeps key exposure step-local and audit opt-in`, () => {
      const workflow = parse(readFileSync(resolve(root, '.github/workflows', path), 'utf8'));
      if (path === 'deploy-staging.yml') {
        expect(workflow.on.workflow_dispatch.inputs.github_trigger_audit_send_only.default).toBe(
          false
        );
        expect(workflow.jobs.deploy.if).toContain('!inputs.github_trigger_audit_send_only');
      } else {
        expect(workflow.permissions).toEqual({});
        expect(workflow.jobs['validate-manual-dispatch'].permissions).toEqual({
          contents: 'read',
          actions: 'read',
        });
        expect(workflow.jobs['github-trigger-audit'].permissions).toEqual({ contents: 'read' });
        expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
        expect(workflow.on.workflow_dispatch.inputs.target_commit_sha.required).toBe(true);
        expect(workflow.on.workflow_dispatch.inputs.emergency_override_reason).toBeUndefined();
        expect(workflow.concurrency.group).toContain("'deploy-production'");
        expect(workflow.jobs['validate-manual-dispatch'].if).toContain(
          "github.repository == 'raphaeltm/simple-agent-manager'"
        );
      }
      const job =
        path === 'github-trigger-production-audit.yml'
          ? workflow.jobs['github-trigger-audit']
          : workflow.jobs['smoke-tests'];
      expect(job.env?.GH_WEBHOOK_SECRET).toBeUndefined();
      expect(job.env?.GH_APP_PRIVATE_KEY).toBeUndefined();
      const secretSteps = job.steps.filter(
        (step: { env?: Record<string, unknown> }) => step.env?.GH_WEBHOOK_SECRET
      );
      expect(secretSteps).toHaveLength(1);
      expect(secretSteps[0].run).toBe('node scripts/e2e/github-trigger-staging.mjs --phase=send');
      if (path === 'github-trigger-production-audit.yml') {
        expect(job.if).toContain("github.ref == 'refs/heads/main'");
        expect(job.if).toContain("needs.validate-manual-dispatch.result == 'success'");
        expect(job.environment).toBe('production');
        expect(job.steps[0].with.ref).toBe('refs/heads/main');
        const guard = job.steps.find(
          (step: { name: string }) => step.name === 'Verify checked-out production SHA'
        );
        expect(job.steps.indexOf(guard)).toBeLessThan(job.steps.indexOf(secretSteps[0]));
        expect(guard.env.EXPECTED_DEPLOY_SHA).toBe(
          '${{ needs.validate-manual-dispatch.outputs.deploy_sha }}'
        );
      } else expect(secretSteps[0].if).toContain('inputs.github_trigger_audit_send_only');
    });
  }
});

it('keeps production deployment separate from the manual audit and rejects untrusted dispatch contexts', () => {
  const deployment = parse(readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8'));
  expect(deployment.jobs['github-trigger-audit']).toBeUndefined();
  expect(deployment.on.workflow_dispatch.inputs.github_trigger_audit_send_only).toBeUndefined();
  const workflow = parse(
    readFileSync(resolve(root, '.github/workflows/github-trigger-production-audit.yml'), 'utf8')
  );
  for (const job of Object.values(workflow.jobs) as Array<{ if: string }>) {
    // Execute the actual workflow condition with GitHub's scalar comparison semantics.
    const condition = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    function admits(event: string, ref: string, repository: string, result = 'success') {
      const expression = condition
        .replaceAll('github.event_name', JSON.stringify(event))
        .replaceAll('github.ref', JSON.stringify(ref))
        .replaceAll('github.repository', JSON.stringify(repository))
        .replaceAll('needs.validate-manual-dispatch.result', JSON.stringify(result));
      return expression.split('&&').every((comparison: string) => {
        const [actual, expected] = comparison.trim().split(' == ');
        return JSON.parse(actual) === expected.slice(1, -1);
      });
    }
    expect(admits('workflow_dispatch', 'refs/heads/main', 'raphaeltm/simple-agent-manager')).toBe(
      true
    );
    expect(admits('workflow_run', 'refs/heads/main', 'raphaeltm/simple-agent-manager')).toBe(false);
    expect(admits('pull_request_target', 'refs/heads/main', 'raphaeltm/simple-agent-manager')).toBe(
      false
    );
    expect(
      admits('workflow_dispatch', 'refs/heads/feature', 'raphaeltm/simple-agent-manager')
    ).toBe(false);
    expect(admits('workflow_dispatch', 'refs/heads/main', 'attacker/fork')).toBe(false);
  }
});

describe('audit cleanup ownership', () => {
  const trigger = {
    id: fixture.triggerId,
    name: fixture.marker,
    sourceType: 'github',
    promptTemplate: auditPrompt(fixture.marker),
    githubConfig: {
      eventType: 'issues',
      filters: { actions: ['opened'], labels: [fixture.marker], bodyContains: fixture.marker },
    },
  };
  it('recovers an actual form-created trigger by its unique marker', () => {
    expect(findOwnedAuditTrigger({ marker: fixture.marker }, [trigger])).toBe(fixture.triggerId);
  });
  it('rejects unrelated or stale IDs before reading their executions', () => {
    expect(() => findOwnedAuditTrigger({ ...fixture, triggerId: 'other' }, [trigger])).toThrow();
    expect(() => findOwnedAuditTrigger(fixture, [{ ...trigger, name: 'Other trigger' }])).toThrow();
  });
  it.each(['source', 'actions', 'labels', 'body', 'prompt'])(
    'rejects changed fixture %s configuration for cleanup',
    (variant) => {
      const changed = structuredClone(trigger);
      if (variant === 'source') changed.sourceType = 'cron';
      if (variant === 'actions') changed.githubConfig.filters.actions = ['closed'];
      if (variant === 'labels') changed.githubConfig.filters.labels = ['other'];
      if (variant === 'body') changed.githubConfig.filters.bodyContains = 'other';
      if (variant === 'prompt') changed.promptTemplate = 'Do unrelated work';
      expect(() => findOwnedAuditTrigger(fixture, [changed])).toThrow();
    }
  );
});

describe('actual project detail fixture contract', () => {
  const project = {
    id: fixture.projectId,
    status: 'active',
    repoProvider: 'github',
    repository: 'Test/Repo',
    installationId: 'internal-installation',
  };
  const installations = [{ id: 'internal-installation', installationId: 12345 }];
  const repository = { id: 9876, fullName: 'test/repo', installationId: 'internal-installation' };
  it('resolves immutable ID from normal OAuth repository response when detail omits githubRepoId', () => {
    expect(
      resolveAuditRepository(project, installations, { repositories: [repository] }, 12345)
    ).toEqual({ repository: 'test/repo', repositoryId: 9876 });
  });
  it.each([
    [],
    [{ ...repository, installationId: 'another-installation' }],
    [repository, repository],
    [{ ...repository, id: 0 }],
  ])(
    'rejects absent, cross-installation, ambiguous or invalid repository evidence',
    (repositories) => {
      expect(() =>
        resolveAuditRepository(project, installations, { repositories }, 12345)
      ).toThrow();
    }
  );
  it('rejects mismatched external installation and detached project', () => {
    expect(() =>
      resolveAuditRepository(project, installations, { repositories: [repository] }, 555)
    ).toThrow();
    expect(() =>
      resolveAuditRepository(
        { ...project, status: 'detached' },
        installations,
        { repositories: [repository] },
        12345
      )
    ).toThrow();
  });
});

describe('normal smoke signed-cookie browser contract', () => {
  it('preserves signed value and established secure staging-domain attributes', () => {
    expect(
      smokeSessionCookie(
        [
          '__Secure-better-auth.session_token',
          'opaque.signature%3D; Path=/; HttpOnly; Secure',
        ].join('=')
      )
    ).toEqual({
      name: '__Secure-better-auth.session_token',
      value: 'opaque.signature=',
      domain: '.sammy.party',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    });
  });
  it('rejects malformed encoding without disclosing cookie contents', () => {
    expect(() =>
      smokeSessionCookie(['better-auth.session_token', 'private-canary%ZZ'].join('='))
    ).toThrow('Malformed signed session cookie');
  });
  it('fails missing cookie without disclosing header content', () => {
    expect(() => smokeSessionCookie('private-header-canary')).toThrow(
      'Token login succeeded without signed session cookie'
    );
  });
});

describe('successful audit reply requirement', () => {
  const message = { role: 'assistant', content: fixture.marker };
  it('requires awaiting-followup and an actual matching assistant reply', () => {
    expect(
      hasAuditReply(
        { status: 'in_progress', executionStep: 'awaiting_followup' },
        [message],
        fixture.marker
      )
    ).toBe(true);
    expect(
      hasAuditReply(
        { status: 'in_progress', executionStep: 'executing' },
        [message],
        fixture.marker
      )
    ).toBe(false);
    expect(
      hasAuditReply(
        { status: 'failed', executionStep: 'awaiting_followup' },
        [message],
        fixture.marker
      )
    ).toBe(false);
    expect(
      hasAuditReply(
        { status: 'in_progress', executionStep: 'awaiting_followup' },
        [{ role: 'user', content: fixture.marker }],
        fixture.marker
      )
    ).toBe(false);
    expect(
      hasAuditReply(
        { status: 'in_progress', executionStep: 'awaiting_followup' },
        [],
        fixture.marker
      )
    ).toBe(false);
  });
});

it('reads ordered assistant chunks across exact-cursor pages and never uses user text', async () => {
  const chunks = [...fixture.marker].map((content, i) => ({
    id: `chunk-${i}`,
    createdAt: 1000,
    sequence: i,
    role: 'assistant',
    content,
  }));
  const seen = [];
  const messages = await readAuditMessages(async (after) => {
    seen.push(after);
    const start = after ? JSON.parse(after)[1] + 1 : 0;
    return { messages: chunks.slice(start, start + 20), hasMore: start + 20 < chunks.length };
  });
  expect(seen[1]).toBe(JSON.stringify([1000, 19, 'chunk-19']));
  expect(
    hasAuditReply(
      { status: 'in_progress', executionStep: 'awaiting_followup' },
      messages,
      fixture.marker
    )
  ).toBe(true);
  expect(
    hasAuditReply(
      { status: 'in_progress', executionStep: 'awaiting_followup' },
      chunks.map((x) => ({ ...x, role: 'user' })),
      fixture.marker
    )
  ).toBe(false);
});
it('rejects truncated or stalled message pagination', async () => {
  await expect(
    readAuditMessages(async () => ({
      messages: [{ id: 'same', createdAt: 1, sequence: 1, role: 'assistant', content: 'x' }],
      hasMore: true,
    }))
  ).rejects.toThrow('Message cursor did not advance');
  await expect(readAuditMessages(async () => ({ messages: [], hasMore: true }))).rejects.toThrow(
    'Missing exact message cursor'
  );
});

it('production checkout guard rejects main drift before signing', () => {
  const workflow = parse(
    readFileSync(resolve(root, '.github/workflows/github-trigger-production-audit.yml'), 'utf8')
  );
  const guard = workflow.jobs['github-trigger-audit'].steps.find(
    (step: { name: string }) => step.name === 'Verify checked-out production SHA'
  );
  const directory = mkdtempSync(join(tmpdir(), 'sam-audit-checkout-'));
  try {
    writeFileSync(join(directory, 'git'), '#!/bin/sh\nprintf "%s\\n" "$TEST_CHECKOUT_SHA"\n', {
      mode: 0o700,
    });
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      EXPECTED_DEPLOY_SHA: 'a'.repeat(40),
      TEST_CHECKOUT_SHA: 'a'.repeat(40),
    };
    expect(() => execFileSync('bash', ['-c', guard.run], { env, stdio: 'pipe' })).not.toThrow();
    expect(() =>
      execFileSync('bash', ['-c', guard.run], {
        env: { ...env, TEST_CHECKOUT_SHA: 'b'.repeat(40) },
        stdio: 'pipe',
      })
    ).toThrow();
    expect(() =>
      execFileSync('bash', ['-c', guard.run], {
        env: { ...env, EXPECTED_DEPLOY_SHA: 'malformed', TEST_CHECKOUT_SHA: 'malformed' },
        stdio: 'pipe',
      })
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
