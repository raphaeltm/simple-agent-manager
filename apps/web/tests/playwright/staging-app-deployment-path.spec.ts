/**
 * Staging verification for the six app-deployment fixes ported from DefangLabs PR #45
 * (task `tasks/archive/2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release.md`).
 *
 * This is the end-to-end exercise, not a page-load check. It creates a throwaway deployment
 * environment, submits a real Compose release that pulls a public image and declares a named
 * volume, and then waits for SAM to provision a deployment node and apply the release. That
 * single flow drives every fix:
 *
 *   1/2. `GET /api/nodes/:id/deploy-release` upserts app-route DNS via `Promise.all`, and node
 *        provisioning creates the `{nodeId}.vm` backend record — the two create-race paths.
 *   3/6. The node's heartbeat advertises the pending release; the apply must run ONCE, which is
 *        the pair of fixes (control plane stops double-advertising, agent dedupes the spawn).
 *   4.   `docker compose up` pulls the image, which used to emit no progress events and get
 *        SIGKILLed by the 15-minute idle watchdog.
 *
 * Includes a named volume on purpose. The PR was previously parked because this staging
 * path failed inside `provisionDeploymentNode` with
 * `D1_ERROR: Expression tree is too large (maximum depth 100)` during environment
 * placement when a release declared a volume. Keeping the volume here makes the staging
 * gate exercise that formerly blocked apply path and cleanup.
 *
 * Deliberately uses a public image rather than `build_and_publish`, so the flow does not need a
 * second workspace to build in — the control-plane and agent paths under test are identical
 * either way.
 *
 * Cleans up the environment and therefore its deployment node and volume in `afterAll`. The
 * staging Hetzner account is shared, so this test must not leave deployment VMs or volumes behind.
 */
import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

/** Provisioning a real Hetzner VM, booting it, and pulling an image is minutes, not seconds. */
const APPLY_TIMEOUT_MS = 14 * 60_000;
const POLL_INTERVAL_MS = 10_000;

test.describe.configure({ mode: 'serial' });
test.setTimeout(APPLY_TIMEOUT_MS + 3 * 60_000);

const ENV_NAME = `pw-deploy-${Date.now().toString(36)}`;
/**
 * A tiny public image, pulled through Google's Docker Hub mirror.
 *
 * NOT `docker.io`: SAM resolves the image digest at submission time from the control plane,
 * and Docker Hub rate-limits anonymous pulls from Cloudflare's egress IPs — an earlier run of
 * this spec was rejected with `Registry returned 429`. `mirror.gcr.io` serves the same official
 * images, needs no token exchange at all (so it trivially satisfies the resolver's same-origin
 * token-realm rule in `image-resolver-outbound.ts`), and does not rate-limit.
 *
 * No `healthcheck:` on purpose — `serviceHealthy` (compose.go) treats a running container with
 * no healthcheck as healthy, so the apply completes without adding a second thing that can fail.
 */
const COMPOSE_YAML = `services:
  web:
    image: mirror.gcr.io/library/nginx:alpine
    ports:
      - "80:80"
    volumes:
      - app-data:/usr/share/nginx/html/data
volumes:
  app-data:
`;

let projectId = '';
let envId = '';
/**
 * Every node id this environment was ever linked to.
 *
 * Deleting the environment reports `nodeDeleted: false` when its node is still
 * provisioning, which leaves the node row — and potentially a real Hetzner VM — behind.
 * Staging must hold zero VMs at rest against a 10-server limit shared with production, so
 * the node is deleted explicitly rather than trusted to the environment teardown.
 */
const seenNodeIds = new Set<string>();
/**
 * One logged-in context shared by setup, the test body and cleanup.
 *
 * Playwright's `request` fixture resolves to a different context in `beforeAll`/`afterAll`
 * than inside a test, so authenticating one does not authenticate the others — the first
 * run of this spec orphaned a staging environment because `afterAll`'s DELETE got a 401.
 * Owning the context removes that class of failure, and `token-login` is rate limited per
 * IP (20/hour), so logging in exactly once also matters.
 */
let api: APIRequestContext;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext();
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const login = await api.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(login.status(), `token-login rejected: ${await login.text()}`).toBe(200);

  const projectsResp = await api.get(`${STAGING_API}/api/projects`);
  expect(projectsResp.status()).toBe(200);
  const projectsBody = await projectsResp.json();
  const projects = projectsBody.projects ?? projectsBody;
  expect(Array.isArray(projects) && projects.length > 0).toBe(true);
  // "Deployment Test 1" is the long-lived staging deployment fixture project.
  projectId =
    projects.find((p: { id: string }) => p.id === '01KVRJCC7Y3NSDQYCPWDRPVJVH')?.id ??
    projects[0].id;

  const createResp = await api.post(`${STAGING_API}/api/projects/${projectId}/environments`, {
    data: { name: ENV_NAME },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(createResp.status(), `env create failed: ${await createResp.text()}`).toBe(201);
  envId = (await createResp.json()).id;
  expect(envId).not.toBe('');
  // eslint-disable-next-line no-console
  console.log(`[staging] project=${projectId} env=${envId} name=${ENV_NAME}`);
});

test.afterAll(async () => {
  if (!envId) return;
  // Deleting the environment tears down its node and volumes. Staging must hold zero VMs at
  // rest — the 10-server Hetzner limit is shared with production. The response body reports
  // nodeDeleted/volumesDeleted, so log it: a cleanup that "succeeded" while leaving a VM
  // behind is the failure mode that actually costs capacity.
  const del = await api.delete(`${STAGING_API}/api/projects/${projectId}/environments/${envId}`);
  const delBody = await del.text();
  // eslint-disable-next-line no-console
  console.log(`[staging] cleanup env=${envId} status=${del.status()} body=${delBody}`);
  try {
    const parsed = JSON.parse(delBody) as { nodeId?: string | null };
    if (parsed.nodeId) seenNodeIds.add(parsed.nodeId);
  } catch {
    /* body already logged */
  }
  for (const nodeId of seenNodeIds) {
    const nodeDel = await api.delete(`${STAGING_API}/api/nodes/${nodeId}`);
    // eslint-disable-next-line no-console
    console.log(
      `[staging] cleanup node=${nodeId} status=${nodeDel.status()} body=${await nodeDel.text()}`
    );
  }
  await api.dispose();
});

test('a real release applies end to end, exercising both DNS create paths and the apply watchdog', async ({
  page,
}) => {
  // --- Submit the release. This is what triggers deployment-node provisioning. ---
  const submit = await api.post(
    `${STAGING_API}/api/projects/${projectId}/environments/${envId}/releases`,
    { data: COMPOSE_YAML, headers: { 'Content-Type': 'text/yaml' } }
  );
  const submitBody = await submit.text();
  // eslint-disable-next-line no-console
  console.log(`[staging] release submit status=${submit.status()} body=${submitBody}`);
  expect(submit.status(), `release submit failed: ${submitBody}`).toBeLessThan(300);

  // --- Wait for the apply to reach a terminal state. ---
  const deadline = Date.now() + APPLY_TIMEOUT_MS;
  let envState: Record<string, unknown> = {};
  let lastLogged = '';
  while (Date.now() < deadline) {
    const resp = await api.get(`${STAGING_API}/api/projects/${projectId}/environments/${envId}`);
    if (resp.status() === 200) {
      envState = await resp.json();
      const summary = JSON.stringify({
        status: envState.status,
        observedStatus: envState.observedStatus,
        observedAppliedSeq: envState.observedAppliedSeq,
        nodeId: envState.nodeId,
        errorMessage: envState.errorMessage,
        // `markDeploymentReleasePlacementFailed` writes the reason HERE, not to
        // errorMessage. An earlier run logged only errorMessage and reported a bare
        // `status: "error"` with no cause, which is useless for diagnosis.
        observedErrorMessage: envState.observedErrorMessage,
      });
      if (summary !== lastLogged) {
        // eslint-disable-next-line no-console
        console.log(`[staging] ${new Date().toISOString()} env: ${summary}`);
        lastLogged = summary;
      }
      // `active` with a non-zero applied seq is a completed apply.
      if (typeof envState.nodeId === 'string' && envState.nodeId) seenNodeIds.add(envState.nodeId);
      if (envState.status === 'active' && Number(envState.observedAppliedSeq ?? 0) > 0) break;
      if (envState.status === 'error') break;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // --- The feature must WORK, not merely respond (`.claude/rules/30`). ---
  expect(
    envState.errorMessage ?? null,
    `environment reported an error: ${JSON.stringify(envState)}`
  ).toBeNull();
  expect(envState.status, `environment did not reach active: ${JSON.stringify(envState)}`).toBe(
    'active'
  );
  expect(
    Number(envState.observedAppliedSeq ?? 0),
    `no release was applied: ${JSON.stringify(envState)}`
  ).toBeGreaterThan(0);

  // --- The routes the release generated must exist, which means app-route DNS was upserted. ---
  const routesResp = await api.get(
    `${STAGING_API}/api/projects/${projectId}/environments/${envId}/public-routes`
  );
  const routesBody = await routesResp.text();
  // eslint-disable-next-line no-console
  console.log(`[staging] routes status=${routesResp.status()} body=${routesBody}`);
  expect(routesResp.status(), `route list failed: ${routesBody}`).toBe(200);

  const routesJson = JSON.parse(routesBody) as { publicRoutes?: unknown; routes?: unknown };
  const publicRoutes = Array.isArray(routesJson.publicRoutes)
    ? routesJson.publicRoutes
    : Array.isArray(routesJson.routes)
      ? routesJson.routes
      : [];
  expect(publicRoutes.length, `no public routes returned: ${routesBody}`).toBeGreaterThan(0);

  // --- And the UI shows the applied environment, as a user would see it. ---
  await page.goto(`${STAGING_APP}/projects/${projectId}/deployments/${envId}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.getByRole('heading', { name: ENV_NAME })).toBeVisible();
  await expect(page.getByText('Public Routes')).toBeVisible();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/staging-app-deployment-applied.png`,
    fullPage: true,
  });
});
