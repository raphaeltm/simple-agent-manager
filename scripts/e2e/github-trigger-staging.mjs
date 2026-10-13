/** Opt-in staging proof, split around the existing CI-held signing key.
 * Fixture files contain metadata only. Tokens/signatures stay in memory. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { auditPrompt, findOwnedAuditTrigger } from './github-trigger-audit-fixture.mjs';

const required = (name) => {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
};
const phase = process.argv.find((value) => value.startsWith('--phase='))?.slice(8);
assert(['prepare', 'send', 'verify'].includes(phase), 'Use --phase=prepare, send, or verify');
const apiUrl = required('SMOKE_TEST_API_URL');
const targetEnvironment = process.env.GITHUB_TRIGGER_AUDIT_ENVIRONMENT || 'staging';
assert(['staging', 'production'].includes(targetEnvironment), 'Invalid audit environment');
assert(
  targetEnvironment === 'staging' || phase === 'send',
  'Production uses operator-managed fixture and verification'
);
const expectedOrigin =
  targetEnvironment === 'production'
    ? `https://api.${required('BASE_DOMAIN')}`
    : 'https://api.sammy.party';
assert(
  new URL(apiUrl).origin === expectedOrigin &&
    !new URL(apiUrl).username &&
    !new URL(apiUrl).password,
  'Approved API origin required'
);
const appUrl = phase === 'send' ? undefined : required('SMOKE_TEST_URL');
if (appUrl)
  assert(
    new URL(appUrl).origin === 'https://app.sammy.party' &&
      !new URL(appUrl).username &&
      !new URL(appUrl).password,
    'Staging app required'
  );
const output = process.env.GITHUB_TRIGGER_AUDIT_OUTPUT || '.codex/tmp/github-trigger-staging';
await mkdir(output, { recursive: true });
const fixturePath = process.env.GITHUB_TRIGGER_AUDIT_FIXTURE_PATH || `${output}/fixture.json`;
const requestTimeoutMs = Number(process.env.GITHUB_TRIGGER_AUDIT_REQUEST_TIMEOUT_MS || '15000');
assert(Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0, 'Invalid request timeout');
const readFixture = async () =>
  JSON.parse(process.env.GITHUB_TRIGGER_AUDIT_FIXTURE || (await readFile(fixturePath, 'utf8')));
function validateFixture(fixture) {
  assert(/^github-trigger-audit-[a-f0-9-]{36}$/.test(fixture.marker), 'Invalid fixture marker');
  assert(/^[a-f0-9-]{36}$/.test(fixture.deliveryId), 'Invalid fixture delivery ID');
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
async function readAppMetadata(fixture) {
  const appId = required('GH_APP_ID');
  const privateKey = required('GH_APP_PRIVATE_KEY');
  const pem = privateKey.includes('-----BEGIN')
    ? privateKey.replace(/\\+n/g, '\n')
    : Buffer.from(privateKey, 'base64').toString('utf8');
  const now = Math.floor(Date.now() / 1000);
  // GitHub App JWT protocol permits at most 10 minutes; use 9 minutes and clock skew allowance.
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })
  ).toString('base64url');
  const unsigned = `${header}.${claims}`;
  const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pem).toString('base64url')}`;
  const get = async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2026-03-10',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
      redirect: 'error',
    });
    assert(response.ok, `GitHub metadata HTTP ${response.status}`);
    return response.json();
  };
  const app = await get('/app');
  const installation = await get(`/app/installations/${fixture.installationId}`);
  const hook = await get('/app/hook/config');
  const hookDestination = new URL(hook.url);
  const hookEvidence = {
    contentType: hook.content_type,
    tlsVerified: String(hook.insecure_ssl) === '0',
    destinationMatchesExpected:
      hookDestination.href === `${apiUrl}/api/github/webhook` &&
      !hookDestination.username &&
      !hookDestination.password &&
      !hookDestination.search &&
      !hookDestination.hash,
  };
  const supportedEvents = ['issues', 'issue_comment', 'pull_request', 'push'];
  const evidence = {
    webhookConfiguration: hookEvidence,
    appSlug: app.slug,
    subscribedEvents: app.events,
    appPermissions: app.permissions,
    installationPermissions: installation.permissions,
    repositorySelection: installation.repository_selection,
    suspendedAt: installation.suspended_at,
    missingSupportedEvents: supportedEvents.filter((event) => !app.events?.includes(event)),
  };
  console.log(JSON.stringify({ githubAppMetadata: evidence }));
  assert(
    hookEvidence.contentType === 'json' &&
      hookEvidence.tlsVerified &&
      hookEvidence.destinationMatchesExpected,
    'GitHub App webhook configuration mismatch'
  );
  assert(
    evidence.missingSupportedEvents.length === 0 && installation.suspended_at === null,
    'GitHub App subscription/installation mismatch'
  );
}
if (phase === 'send') {
  const fixture = await readFixture();
  validateFixture(fixture);
  try {
    await readAppMetadata(fixture);
  } catch {
    console.error('GitHub App metadata audit failed; key/token/request details suppressed');
    process.exitCode = 1;
  }
  const payload = JSON.stringify({
    action: 'opened',
    installation: { id: fixture.installationId },
    repository: { id: fixture.repositoryId, full_name: fixture.repository },
    sender: {
      login: targetEnvironment === 'production' ? 'simple-agent-manager[bot]' : 'sam-staging-audit',
      type: targetEnvironment === 'production' ? 'Bot' : 'User',
    },
    issue: {
      id: 1,
      number: 1,
      title: `${fixture.marker} Résumé 🐙`,
      body: fixture.marker,
      labels: [{ name: fixture.marker }],
      state: 'open',
    },
  });
  const signature = `sha256=${createHmac('sha256', required('GH_WEBHOOK_SECRET')).update(payload).digest('hex')}`;
  let passed = !process.exitCode;
  for (let attempt = 0; passed && attempt < 2; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/api/github/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'issues',
          'X-GitHub-Delivery': fixture.deliveryId,
        },
        body: payload,
        signal: AbortSignal.timeout(requestTimeoutMs),
        redirect: 'error',
      });
      console.log(
        JSON.stringify({
          syntheticSignedDelivery: true,
          deliveryId: fixture.deliveryId,
          attempt,
          status: response.status,
        })
      );
      if (response.status !== 200) {
        passed = false;
        break;
      }
    } catch {
      passed = false;
      console.error('Signed staging send failed; request details suppressed');
      break;
    }
  }
  // A 200 only proves ingress accepted; local verify must inspect actual admission.
  if (!passed) process.exitCode = 1;
} else {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let fixture =
    phase === 'verify'
      ? await readFixture()
      : {
          marker: `github-trigger-audit-${randomUUID()}`,
          deliveryId: randomUUID(),
          projectId: required('GITHUB_TRIGGER_AUDIT_PROJECT_ID'),
          installationId: Number(required('GITHUB_TRIGGER_AUDIT_INSTALLATION_ID')),
        };
  if (phase === 'verify') validateFixture(fixture);
  const prefix = `/api/projects/${fixture.projectId}`;
  let step = 'login';
  let retain = false;
  const result = {
    phase,
    marker: fixture.marker,
    projectId: fixture.projectId,
    checks: [],
    cleanup: [],
  };
  async function request(path, method = 'GET', body) {
    const response = await context.request.fetch(`${apiUrl}${path}`, {
      method,
      data: body,
      timeout: requestTimeoutMs,
    });
    assert(response.ok(), `${method} ${path}: HTTP ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  }
  async function recoverTrigger() {
    const claimed = { ...fixture };
    // Clear first: failed lookup/ownership validation must never permit deletion by stale ID.
    fixture.triggerId = undefined;
    const list = await request(`${prefix}/triggers`);
    fixture.triggerId = findOwnedAuditTrigger(claimed, list.triggers);
  }

  try {
    const login = await request('/api/auth/token-login', 'POST', {
      token: required('SMOKE_TEST_TOKEN'),
    });
    assert(login.success, 'Token login failed');
    if (phase === 'prepare') {
      step = 'fixture access';
      const project = await request(prefix);
      assert(
        project.status === 'active' && project.repoProvider === 'github',
        'Active GitHub project required'
      );
      fixture.repository = project.repository;
      fixture.repositoryId = project.githubRepoId;
      const installations = await request('/api/github/installations');
      const installation = installations.find((item) => item.id === project.installationId);
      assert(
        installation && Number(installation.installationId) === fixture.installationId,
        'Fixture installation mismatch'
      );
      const repositories = await request(
        `/api/github/repositories?installation_id=${encodeURIComponent(project.installationId)}`
      );
      assert(
        repositories.repositories.some(
          (item) =>
            item.id === fixture.repositoryId &&
            item.fullName.toLowerCase() === fixture.repository.toLowerCase()
        ),
        'Existing smoke OAuth principal lacks fixture access'
      );
      const before = await request(`${prefix}/triggers`);
      assert(
        !before.triggers.some((item) => item.sourceType === 'github'),
        'Fixture already has GitHub triggers'
      );
      result.checks.push(
        'normal smoke OAuth principal and fixture have access; no other fixture GitHub triggers'
      );
      step = 'actual form';
      await page.goto(`${appUrl}/projects/${fixture.projectId}/triggers`);
      await page
        .getByRole('button', { name: /New Trigger|Create your first trigger/ })
        .first()
        .click();
      await page.getByRole('button', { name: /GitHub event/ }).click();
      await page.getByLabel('Name', { exact: true }).fill(fixture.marker);
      await page.getByLabel('GitHub event', { exact: true }).selectOption('issues');
      assert(
        (await page.getByLabel('Actions', { exact: true }).inputValue()) === 'opened',
        'Issue default is not opened'
      );
      await page.getByLabel('Required labels').fill(fixture.marker);
      await page.getByLabel('Text contains').fill(fixture.marker);
      await page.getByLabel('Prompt template', { exact: true }).fill(auditPrompt(fixture.marker));
      await page.screenshot({ path: `${output}/form-desktop.png` });
      await page.setViewportSize({ width: 375, height: 667 });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Mobile overflow'
      );
      await page.screenshot({ path: `${output}/form-mobile.png` });
      await page.getByRole('button', { name: 'Create Trigger', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await recoverTrigger();
      assert(fixture.triggerId, 'Form did not persist trigger');
      validateFixture(fixture);
      const after = await request(`${prefix}/triggers`);
      const created = after.triggers.find((item) => item.id === fixture.triggerId);
      assert.deepEqual(created.githubConfig.filters.actions, ['opened']);
      assert(
        after.triggers.filter((item) => item.sourceType === 'github').length === 1,
        'Concurrent GitHub trigger detected'
      );
      const config = (item) =>
        Object.fromEntries(
          [
            'name',
            'description',
            'sourceType',
            'status',
            'cronExpression',
            'cronTimezone',
            'skipIfRunning',
            'promptTemplate',
            'agentProfileId',
            'taskMode',
            'maxConcurrent',
            'resourceRequirementsJson',
            'githubConfig',
            'webhookConfig',
          ].map((key) => [key, item[key]])
        );
      for (const original of before.triggers)
        assert.deepEqual(
          config(after.triggers.find((item) => item.id === original.id)),
          config(original),
          'Unrelated trigger configuration changed'
        );
      result.checks.push(
        'actual mobile/desktop form persisted opened and preserved unrelated configuration'
      );
      await writeFile(fixturePath, JSON.stringify(fixture, null, 2));
      retain = true;
      result.pass = true;
    } else {
      step = 'fixture ownership';
      await recoverTrigger();
      assert(fixture.triggerId, 'Owned audit trigger not found');
      step = 'actual admission';
      const deadline = Date.now() + Number(process.env.GITHUB_TRIGGER_AUDIT_TIMEOUT_MS || '120000');
      let execution;
      let task;
      do {
        const executions = await request(`${prefix}/triggers/${fixture.triggerId}/executions`);
        assert(executions.executions.length <= 1, 'Duplicate execution for one delivery ID');
        execution = executions.executions[0];
        if (execution?.status === 'failed') throw new Error('Trigger admission failed');
        if (execution?.taskId) {
          task = await request(`${prefix}/tasks/${execution.taskId}`);
          assert(!['failed', 'cancelled'].includes(task.status), 'Admitted task failed');
          if (['in_progress', 'completed'].includes(task.status)) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      assert(
        execution?.taskId && ['in_progress', 'completed'].includes(task?.status),
        'Task did not start before deadline'
      );
      assert(execution.renderedPrompt.includes(fixture.marker), 'Payload template lost marker');
      result.taskId = execution.taskId;
      result.deliveryId = fixture.deliveryId;
      result.checks.push(
        'signed Unicode issue admitted once; task reached normal running/completed state'
      );
      result.pass = true;
    }
  } catch {
    result.pass = false;
    result.failedStep = step;
  } finally {
    if (!retain) {
      try {
        await recoverTrigger();
      } catch {
        result.cleanup.push('FAILED: marker lookup');
        result.pass = false;
      }
      if (fixture.triggerId) {
        try {
          const executions = await request(`${prefix}/triggers/${fixture.triggerId}/executions`);
          for (const taskId of new Set(
            executions.executions.map((item) => item.taskId).filter(Boolean)
          )) {
            const task = await request(`${prefix}/tasks/${taskId}`);
            if (!['completed', 'failed', 'cancelled'].includes(task.status))
              await request(`${prefix}/tasks/${taskId}/status`, 'POST', {
                toStatus: 'cancelled',
                reason: 'Bounded GitHub trigger staging verification cleanup',
              });
            await request(`${prefix}/tasks/${taskId}/run/cleanup`, 'POST', {});
            result.cleanup.push(
              `task ${taskId} terminalized; normal asynchronous runtime cleanup requested`
            );
          }
        } catch {
          result.cleanup.push('FAILED: task/runtime cleanup');
          result.pass = false;
        }
        try {
          await request(`${prefix}/triggers/${fixture.triggerId}`, 'DELETE');
          result.cleanup.push('temporary trigger removed');
        } catch {
          result.cleanup.push('FAILED: trigger deletion');
          result.pass = false;
        }
      }
    }
    try {
      await browser.close();
    } catch {
      result.cleanup.push('FAILED: browser close');
      result.pass = false;
    }
    await writeFile(`${output}/${phase}-result.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
  if (!result.pass) process.exitCode = 1;
}
