/** Opt-in staging proof, split around the existing CI-held signing key.
 * Fixture files contain metadata only. Tokens/signatures stay in memory. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import {
  auditPrompt,
  validateAuditFixture,
  auditSignedDeliveryIntents,
  hasAuditReply,
  readAuditMessages,
  findOwnedAuditTrigger,
  resolveAuditRepository,
  smokeSessionCookie,
} from './github-trigger-audit-fixture.mjs';

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
  const supportedEvents = [
    ...new Set([
      'issues',
      'issue_comment',
      'pull_request',
      'push',
      ...(fixture.deliveries ?? []).map((item) => item.eventType),
    ]),
  ];
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
  validateAuditFixture(fixture);
  try {
    await readAppMetadata(fixture);
  } catch {
    console.error('GitHub App metadata audit failed; key/token/request details suppressed');
    process.exitCode = 1;
  }
  const intents = auditSignedDeliveryIntents(fixture, targetEnvironment);
  let passed = !process.exitCode;
  for (let attempt = 0; passed && attempt < 2; attempt++) {
    const results = await Promise.all(
      intents.map(async (intent) => {
        try {
          const signature = `sha256=${createHmac('sha256', required('GH_WEBHOOK_SECRET')).update(intent.payload).digest('hex')}`;
          const response = await fetch(`${apiUrl}/api/github/webhook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Hub-Signature-256': signature,
              'X-GitHub-Event': intent.eventType,
              'X-GitHub-Delivery': intent.deliveryId,
            },
            body: intent.payload,
            signal: AbortSignal.timeout(requestTimeoutMs),
            redirect: 'error',
          });
          console.log(
            JSON.stringify({
              syntheticSignedDelivery: true,
              deliveryId: intent.deliveryId,
              attempt,
              status: response.status,
            })
          );
          return response.status === 200;
        } catch {
          console.error('Signed staging send failed; request details suppressed');
          return false;
        }
      })
    );
    passed = results.every(Boolean);
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
          agentProfileId: required('GITHUB_TRIGGER_AUDIT_PROFILE_ID'),
        };
  if (phase === 'verify') validateAuditFixture(fixture);
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
    const loginResponse = await context.request.post(`${apiUrl}/api/auth/token-login`, {
      data: { token: required('SMOKE_TEST_TOKEN') },
      timeout: requestTimeoutMs,
    });
    assert(loginResponse.ok(), `Token login HTTP ${loginResponse.status()}`);
    const login = await loginResponse.json();
    assert(login.success, 'Token login failed');
    await context.addCookies([smokeSessionCookie(loginResponse.headers()['set-cookie'] || '')]);
    if (phase === 'prepare') {
      step = 'fixture access';
      const project = await request(prefix);
      const installations = await request('/api/github/installations');
      const repositories = await request(
        `/api/github/repositories?installation_id=${encodeURIComponent(project.installationId)}`
      );
      Object.assign(
        fixture,
        resolveAuditRepository(project, installations, repositories, fixture.installationId)
      );
      const profiles = await request(`${prefix}/agent-profiles`);
      const profile = profiles.items.find((item) => item.id === fixture.agentProfileId);
      assert(
        profile?.agentType === 'openai-codex' &&
          (!profile.workspaceProfile || profile.workspaceProfile === 'full'),
        'Existing full Codex profile required'
      );
      const credentials = await request('/api/credentials/agent');
      assert(
        credentials.credentials.some(
          (item) => item.agentType === 'openai-codex' && item.provider === 'openai' && item.isActive
        ),
        'Existing active Codex credential required'
      );
      const before = await request(`${prefix}/triggers`);
      assert(
        !before.triggers.some((item) => item.sourceType === 'github'),
        'Fixture already has GitHub triggers'
      );
      result.checks.push(
        'normal smoke OAuth principal and fixture have access; no other fixture GitHub triggers'
      );
      step = 'form navigation';
      await page.goto(`${appUrl}/projects/${fixture.projectId}/triggers`);
      await page
        .getByRole('heading', { name: 'Triggers', exact: true })
        .waitFor({ state: 'visible' });
      const accountSetup = page.getByRole('dialog', { name: 'Account setup', exact: true });
      if (await accountSetup.isVisible()) {
        step = 'form dismiss account setup';
        await accountSetup.getByRole('button', { name: 'Exit setup', exact: true }).click();
        await accountSetup.waitFor({ state: 'hidden' });
        result.checks.push(
          'observed Account setup dialog; dismissed through normal Exit setup control'
        );
      }
      step = 'form open';
      await page
        .getByRole('button', { name: /New Trigger|Create your first trigger/ })
        .first()
        .click();
      step = 'form GitHub source';
      await page.getByRole('button', { name: /GitHub event/ }).click();
      step = 'form name';
      await page.getByLabel('Name', { exact: true }).fill(fixture.marker);
      step = 'form event type';
      await page.getByLabel('GitHub event', { exact: true }).selectOption('issues');
      assert(
        (await page.getByLabel('Actions', { exact: true }).inputValue()) === 'opened',
        'Issue default is not opened'
      );
      step = 'form filters';
      await page.getByLabel('Required labels').fill(fixture.marker);
      await page.getByLabel('Text contains').fill(fixture.marker);
      step = 'form prompt';
      await page.getByLabel('Prompt template', { exact: true }).fill(auditPrompt(fixture.marker));
      step = 'form explicit execution';
      await page.getByRole('button', { name: 'Advanced Options', exact: true }).click();
      await page.getByLabel('Agent Profile', { exact: true }).selectOption(fixture.agentProfileId);
      await page.getByLabel('Task mode', { exact: true }).selectOption('conversation');
      step = 'form screenshots';
      await page.screenshot({ path: `${output}/form-desktop.png` });
      await page.setViewportSize({ width: 375, height: 667 });
      assert(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Mobile overflow'
      );
      await page.screenshot({ path: `${output}/form-mobile.png` });
      step = 'form submission';
      await page.getByRole('button', { name: 'Create Trigger', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await recoverTrigger();
      assert(fixture.triggerId, 'Form did not persist trigger');
      validateAuditFixture(fixture);
      const after = await request(`${prefix}/triggers`);
      const created = after.triggers.find((item) => item.id === fixture.triggerId);
      assert.deepEqual(created.githubConfig.filters.actions, ['opened']);
      assert(
        created.agentProfileId === fixture.agentProfileId && created.taskMode === 'conversation',
        'Explicit conversation profile lost'
      );
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
      let agentResponded = false;
      do {
        const executions = await request(`${prefix}/triggers/${fixture.triggerId}/executions`);
        assert(executions.executions.length <= 1, 'Duplicate execution for one delivery ID');
        execution = executions.executions[0];
        if (execution?.status === 'failed') throw new Error('Trigger admission failed');
        if (execution?.taskId) {
          task = await request(`${prefix}/tasks/${execution.taskId}`);
          assert(!['failed', 'cancelled'].includes(task.status), 'Admitted task failed');
          if (
            task.status === 'in_progress' &&
            task.executionStep === 'awaiting_followup' &&
            task.workspaceId
          ) {
            const workspace = await request(`/api/workspaces/${task.workspaceId}`);
            if (workspace.chatSessionId) {
              const messages = await readAuditMessages((after) =>
                request(
                  `${prefix}/sessions/${workspace.chatSessionId}/messages?role=assistant&limit=500&order=asc${after ? `&after=${encodeURIComponent(after)}` : ''}`
                )
              );
              if (hasAuditReply(task, messages, fixture.marker)) {
                agentResponded = true;
                break;
              }
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } while (Date.now() < deadline);
      assert(
        agentResponded &&
          execution?.taskId &&
          task?.status === 'in_progress' &&
          task.executionStep === 'awaiting_followup',
        'Agent did not respond before deadline'
      );
      assert(execution.renderedPrompt.includes(fixture.marker), 'Payload template lost marker');
      result.taskId = execution.taskId;
      result.deliveryId = fixture.deliveryId;
      result.checks.push(
        'signed Unicode issue admitted once; conversation reached awaiting_followup with marker reply'
      );
      result.pass = true;
    }
  } catch {
    result.pass = false;
    result.failedStep = step;
    if (phase === 'prepare' && step.startsWith('form ')) {
      try {
        const path = new URL(page.url()).pathname;
        result.browserDiagnostics = {
          pathKind: /sign.?in|login/.test(path)
            ? 'signin'
            : /onboarding|setup/.test(path)
              ? 'onboarding'
              : /projects\//.test(path)
                ? 'project'
                : 'other',
          newTriggerButtons: await page
            .getByRole('button', { name: /New Trigger|Create your first trigger/ })
            .count(),
          githubSourceButtons: await page.getByRole('button', { name: /GitHub event/ }).count(),
          nameFields: await page.getByLabel('Name', { exact: true }).count(),
          eventFields: await page.getByLabel('GitHub event', { exact: true }).count(),
          dialogs: await page.getByRole('dialog').count(),
          accountSetupDialogs: await page
            .getByRole('dialog', { name: 'Account setup', exact: true })
            .count(),
          createTriggerDialogs: await page
            .getByRole('dialog', { name: 'Create trigger', exact: true })
            .count(),
          exitSetupButtons: await page
            .getByRole('button', { name: 'Exit setup', exact: true })
            .count(),
          newTriggerVisible: await page
            .getByRole('button', { name: 'New Trigger', exact: true })
            .first()
            .isVisible(),
          newTriggerEnabled: await page
            .getByRole('button', { name: 'New Trigger', exact: true })
            .first()
            .isEnabled(),
        };
      } catch {
        result.browserDiagnostics = { diagnosticFailed: true };
      }
    }
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
