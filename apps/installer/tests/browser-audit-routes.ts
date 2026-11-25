import type { Page } from '@playwright/test';

/** Fake installer API for the browser audit: each scenario selects its responses by state. */
export async function installFixtureRoutes(
  page: Page,
  getState: () => string,
  setState: (value: string) => void,
  previewState: { attempts: number } = { attempts: 0 },
  installGate: { release: () => void; hold: Promise<void> } = {
    release: () => {},
    hold: Promise.resolve(),
  }
) {
  await page.route('**/api/config', (r) =>
    r.fulfill({
      json: {
        configured: getState() !== 'unconfigured',
        fullInstaller: getState().startsWith('full-'),
        sourceUrl: 'https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/installer',
        docsUrl: '/self-host.html',
        sha: 'audit-fixture',
      },
    })
  );
  await page.route('**/api/session/status', (r) =>
    ['connect', 'unconfigured', 'authorization'].includes(getState())
      ? r.fulfill({ status: 401, json: { error: 'Sign in' } })
      : r.fulfill({
          json: {
            currentCleanupReceipt: 'e'.repeat(64),
            accounts:
              getState() === 'empty'
                ? []
                : Array.from({ length: 35 }, (_, i) => ({
                    id: String(i).padStart(32, 'a'),
                    name:
                      i === 0
                        ? 'Organization <script>alert(1)</script> & équipe 🧑‍💻 '.repeat(6)
                        : `Account ${i}`,
                  })),
            job:
              getState() === 'ready' || getState() === 'pending'
                ? { status: getState(), name: 'sam-maintenance-1234567890123456' }
                : null,
          },
        })
  );
  await page.route('**/api/session/zones', (r) =>
    r.fulfill({ json: { zones: [{ id: 'b'.repeat(32), name: 'example.com' }] } })
  );
  await page.route('**/api/session/preview', (r) => {
    if (getState() === 'full-adopt') {
      // The browser must send the takeover request and passphrase exactly as typed.
      const body = r.request().postDataJSON() as Record<string, unknown>;
      if (body.adopt !== true || body.statePassphrase !== 'existing state passphrase')
        return r.fulfill({ status: 400, json: { error: 'takeover inputs were not sent' } });
      return r.fulfill({
        json: {
          plan: {
            sourceCommit: 'c'.repeat(40),
            fingerprint: 'd'.repeat(64),
            workersDev: { action: 'preserve', subdomain: 'sam-account' },
            hostnames: ['api.sam.example.com', 'app.sam.example.com'],
            conflicts: [],
            adoption: { prefix: 'sam', environment: 'production', stateBucket: 'sam-pulumi-state' },
          },
        },
      });
    }
    if (getState() === 'full-expired')
      return r.fulfill({
        status: 401,
        json: { error: 'Your installer session expired. Sign in again.' },
      });
    let conflicts: Array<{ name: string; type: string }> = [];
    if (getState() === 'full-conflict')
      conflicts = [{ name: 'api.sam.example.com', type: 'CNAME' }];
    if (getState() === 'full-flow') {
      previewState.attempts++;
      // The first review attempt hits a conflict; "Check again" resolves it,
      // the way a real re-run would after the owner clears the blocking record.
      conflicts =
        previewState.attempts === 1 ? [{ name: 'api.sam.example.com', type: 'CNAME' }] : [];
    }
    return r.fulfill({
      json: {
        plan: {
          sourceCommit: 'c'.repeat(40),
          fingerprint: 'd'.repeat(64),
          workersDev: { action: 'create', subdomain: 'sam-account' },
          hostnames: [
            'api.sam.example.com',
            'app.sam.example.com',
            'preview.sam.example.com',
            '*.sam.example.com',
          ],
          conflicts,
        },
      },
    });
  });
  await page.route('**/api/session/install', async (r) => {
    if (getState() === 'error')
      return r.fulfill({
        status: 500,
        json: {
          error:
            'Cloudflare could not complete this step. Try again. Details: POST /workers/scripts returned HTTP 403 (codes 10000). No credentials were logged.',
        },
      });
    // Held open by 'installing' until the test releases it, so the busy
    // button state is genuinely observed rather than hand-fed.
    if (getState() === 'installing') await installGate.hold;
    setState('ready');
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/session/reconcile-cleanup', async (r) => {
    expect(r.request().postDataJSON()).toEqual({
      receipt: 'd'.repeat(64),
      accountId: 'a'.repeat(31) + '0',
    });
    await r.fulfill({ json: { ok: true, authorityPreserved: true } });
  });
  await page.route('**/api/session/finish', (r) => r.fulfill({ json: { revoked: true } }));
}
