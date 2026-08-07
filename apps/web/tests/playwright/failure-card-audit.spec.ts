import { expect, type Page, test } from '@playwright/test';

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}-${suffix}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

function makeFailureCardHtml(opts: {
  errorMessage: string;
  classification: string;
  explanation: string;
  guidance: string;
  executionStep?: string;
  events?: Array<{ toStatus: string; actorType: string; reason?: string; time: string }>;
  ids?: Record<string, string>;
  showAdmin?: boolean;
}) {
  const eventsHtml = (opts.events ?? [])
    .map(
      (ev) => `
    <div style="display:flex;gap:8px;min-height:28px;">
      <div style="display:flex;flex-direction:column;align-items:center;width:12px;flex-shrink:0;">
        <div style="width:8px;height:8px;border-radius:50%;background:${ev.toStatus === 'failed' ? 'var(--sam-color-danger)' : 'var(--sam-color-accent-primary)'};flex-shrink:0;margin-top:6px;"></div>
        <div style="width:1px;flex:1;min-height:12px;background:var(--sam-form-border);opacity:0.4;"></div>
      </div>
      <div style="flex:1;min-width:0;padding-bottom:4px;">
        <div style="display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;">
          <span style="font-size:11px;font-weight:500;color:${ev.toStatus === 'failed' ? 'var(--sam-color-danger-fg)' : 'var(--sam-color-fg-primary)'};">${ev.toStatus}</span>
          ${ev.actorType !== 'system' ? `<span style="font-size:10px;color:var(--sam-color-fg-muted);">by ${ev.actorType}</span>` : ''}
          <span style="font-size:10px;color:var(--sam-color-fg-muted);margin-left:auto;flex-shrink:0;">${ev.time}</span>
        </div>
        ${ev.reason ? `<p style="font-size:11px;color:var(--sam-color-fg-muted);margin:2px 0 0;line-height:1.4;overflow-wrap:anywhere;">${ev.reason}</p>` : ''}
      </div>
    </div>`,
    )
    .join('');

  const idsHtml = Object.entries(opts.ids ?? {})
    .map(
      ([label, value]) =>
        `<button type="button" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-family:monospace;padding:2px 6px;border-radius:4px;border:1px solid var(--sam-form-border);background:var(--sam-form-bg);color:var(--sam-color-fg-muted);cursor:pointer;">
          <span style="font-size:10px;font-family:sans-serif;font-weight:500;opacity:0.7;">${label}</span>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${value.slice(0, 6)}...${value.slice(-4)}</span>
        </button>`,
    )
    .join('');

  return `
    <div style="border-radius:8px;overflow:hidden;border:1px solid color-mix(in srgb, var(--sam-color-danger) 30%, transparent);background:var(--sam-color-danger-tint);">
      <div style="width:100%;text-align:left;padding:10px 12px;display:flex;align-items:flex-start;gap:8px;cursor:pointer;background:transparent;border:none;">
        <span style="flex-shrink:0;margin-top:2px;color:var(--sam-color-danger-fg);">⚠</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:600;color:var(--sam-color-danger-fg);">${opts.classification}</span>
            <span style="font-size:10px;padding:2px 6px;border-radius:9999px;font-weight:500;background:color-mix(in srgb, var(--sam-color-accent-primary) 12%, transparent);color:var(--sam-color-accent-primary);">Retryable</span>
          </div>
          <p style="font-size:11px;margin:2px 0 0;line-height:1.4;color:var(--sam-color-fg-secondary);">${opts.explanation}</p>
        </div>
      </div>
      <div style="padding:0 12px 12px;display:flex;flex-direction:column;gap:12px;border-top:1px solid color-mix(in srgb, var(--sam-color-danger) 15%, transparent);">
        <div style="display:flex;align-items:flex-start;gap:8px;padding-top:8px;">
          <span style="font-size:10px;font-weight:500;color:var(--sam-color-fg-muted);text-transform:uppercase;flex-shrink:0;margin-top:1px;">Next step</span>
          <p style="font-size:11px;margin:0;line-height:1.4;color:var(--sam-color-fg-primary);">${opts.guidance}</p>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;">
          <span style="font-size:10px;font-weight:500;color:var(--sam-color-fg-muted);text-transform:uppercase;">Error</span>
          <pre style="font-size:11px;font-family:monospace;margin:0;padding:8px;border-radius:6px;word-break:break-word;white-space:pre-wrap;overflow-wrap:anywhere;background:color-mix(in srgb, var(--sam-color-bg-canvas) 60%, transparent);color:var(--sam-color-fg-secondary);border:1px solid var(--sam-form-border);line-height:1.4;">${opts.errorMessage}</pre>
        </div>
        ${
          opts.executionStep
            ? `<div style="display:flex;align-items:baseline;gap:8px;">
                <span style="font-size:10px;font-weight:500;color:var(--sam-color-fg-muted);text-transform:uppercase;flex-shrink:0;">Step</span>
                <span style="font-size:11px;color:var(--sam-color-fg-primary);">${opts.executionStep}</span>
              </div>`
            : ''
        }
        <div style="display:flex;flex-direction:column;gap:4px;">
          <span style="font-size:10px;font-weight:500;color:var(--sam-color-fg-muted);text-transform:uppercase;">Timeline</span>
          <div style="display:flex;flex-direction:column;gap:0;">${eventsHtml}</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${idsHtml}</div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <button type="button" style="display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:500;padding:6px 10px;border-radius:6px;border:1px solid var(--sam-form-border);background:var(--sam-form-bg);color:var(--sam-color-fg-primary);cursor:pointer;">📋 Copy debug report</button>
          ${
            opts.showAdmin
              ? `<a href="/admin/errors" style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;padding:6px 10px;border-radius:6px;border:1px solid var(--sam-form-border);background:var(--sam-form-bg);color:var(--sam-color-accent-primary);text-decoration:none;">↗ View in admin errors</a>`
              : ''
          }
        </div>
      </div>
    </div>`;
}

async function injectStyledHarness(page: Page, innerHtml: string) {
  await page.goto('/');
  await page.evaluate((html) => {
    document.body.innerHTML = `
      <div style="min-height:100vh;background:var(--sam-color-bg-canvas, #0d0d0d);padding:12px;font-family:system-ui,sans-serif;">
        <div style="max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:16px;">
          ${html}
        </div>
      </div>
    `;
  }, innerHtml);
}

test.describe('Failure Card Visual Audit', () => {
  test('normal failure renders without overflow', async ({ page }) => {
    await injectStyledHarness(
      page,
      makeFailureCardHtml({
        errorMessage: 'Agent process exited unexpectedly with code 137',
        classification: 'Agent crashed',
        explanation: 'The agent process exited unexpectedly while working.',
        guidance:
          'SAM usually recovers crashed sessions automatically. If it did not, send a follow-up message or retry.',
        executionStep: 'running',
        events: [
          { toStatus: 'ready', actorType: 'system', time: '10m ago' },
          { toStatus: 'queued', actorType: 'system', time: '10m ago' },
          { toStatus: 'in progress', actorType: 'system', time: '9m ago' },
          { toStatus: 'failed', actorType: 'system', reason: 'Agent process exited unexpectedly with code 137', time: '1m ago' },
        ],
        ids: {
          Task: '01KZF49HNP8HNJDGWB4KWXHEZR',
          Session: '01KZF4T9XHN8944EDE3127J5MC',
          Workspace: '01KZF3ABC123456789',
          Node: '01KZFNODE1234567890',
        },
        showAdmin: true,
      }),
    );

    await screenshot(page, 'failure-card-normal');
    await assertNoOverflow(page);
  });

  test('long error message wraps without overflow', async ({ page }) => {
    const longError =
      'Error: FATAL — the vm-agent process at /usr/local/bin/vm-agent terminated with SIGKILL (signal 9) after exceeding the 2GB memory limit imposed by the cgroup. ' +
      'This typically happens when the agent builds a very large Docker image or loads a massive model checkpoint into memory. ' +
      'Stack trace: at GC::collect() at HeapAllocator::allocate(size=2147483648) at runtime::main() — the OOM killer selected this process because it had the highest oom_score_adj. ' +
      'The devcontainer was running ubuntu:24.04 with 16 packages installed. Previous successful runs used ~800MB peak memory. ' +
      'Suggestions: increase the VM size, optimize the workload to stream data instead of loading it all at once, or split the task into smaller sub-tasks.';

    await injectStyledHarness(
      page,
      makeFailureCardHtml({
        errorMessage: longError,
        classification: 'Agent crashed',
        explanation: 'The agent process exited unexpectedly while working.',
        guidance: 'Consider increasing the VM size or splitting the workload.',
        events: [
          { toStatus: 'ready', actorType: 'system', time: '30m ago' },
          { toStatus: 'in progress', actorType: 'agent', time: '28m ago' },
          { toStatus: 'failed', actorType: 'system', reason: longError.slice(0, 200), time: 'Just now' },
        ],
        ids: { Task: '01KZF49HNP8HNJDGWB4KWXHEZR' },
      }),
    );

    await screenshot(page, 'failure-card-long-error');
    await assertNoOverflow(page);
  });

  test('many events render correctly', async ({ page }) => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      toStatus: i === 29 ? 'failed' : i < 5 ? 'queued' : 'in progress',
      actorType: i % 3 === 0 ? 'agent' : 'system',
      reason: i === 29 ? 'Final failure after 30 transitions' : i % 5 === 0 ? `Checkpoint ${i}` : undefined,
      time: `${30 - i}m ago`,
    }));

    await injectStyledHarness(
      page,
      makeFailureCardHtml({
        errorMessage: 'Task exceeded maximum retry attempts.',
        classification: 'Failed',
        explanation: 'The task could not be completed after multiple attempts.',
        guidance: 'Review the error details and retry with adjusted parameters.',
        events,
        ids: { Task: '01ABC123', Session: '01DEF456', Workspace: '01GHI789', Node: '01JKL012' },
      }),
    );

    await screenshot(page, 'failure-card-many-events');
    await assertNoOverflow(page);
  });

  test('empty state renders cleanly', async ({ page }) => {
    await injectStyledHarness(
      page,
      makeFailureCardHtml({
        errorMessage: '',
        classification: 'Failed',
        explanation: 'An unknown error occurred.',
        guidance: 'Retry the task or contact support.',
        events: [],
        ids: { Task: '01ABC' },
      }),
    );

    await screenshot(page, 'failure-card-empty');
    await assertNoOverflow(page);
  });

  test('special characters render safely', async ({ page }) => {
    await injectStyledHarness(
      page,
      makeFailureCardHtml({
        errorMessage:
          '<script>alert("xss")</script> & "quotes" \'apostrophes\' café naïve Ω∆∑ 中文 العربية 🔥💥🚀 path/to/file.ts:123:45',
        classification: 'Network error',
        explanation: 'A network connectivity issue prevented the operation.',
        guidance: 'Check your connection and retry.',
        events: [
          {
            toStatus: 'failed',
            actorType: 'system',
            reason: 'ECONNREFUSED 127.0.0.1:8787 — retried 3× with backoff',
            time: 'Just now',
          },
        ],
        ids: { Task: '01ABC-<test>"inject"' },
      }),
    );

    await screenshot(page, 'failure-card-special-chars');
    await assertNoOverflow(page);
  });

  test('cancelled task shows muted styling', async ({ page }) => {
    await injectStyledHarness(
      page,
      `<div style="border-radius:8px;overflow:hidden;border:1px solid color-mix(in srgb, var(--sam-color-fg-muted) 30%, transparent);background:rgba(127,127,127,0.06);">
        <div style="width:100%;text-align:left;padding:10px 12px;display:flex;align-items:flex-start;gap:8px;cursor:pointer;background:transparent;border:none;">
          <span style="flex-shrink:0;margin-top:2px;color:var(--sam-color-fg-muted);">✕</span>
          <div style="flex:1;min-width:0;">
            <span style="font-size:12px;font-weight:600;color:var(--sam-color-fg-primary);">Cancelled</span>
            <p style="font-size:11px;margin:2px 0 0;line-height:1.4;color:var(--sam-color-fg-secondary);">The task was stopped intentionally by a user or a parent agent.</p>
          </div>
        </div>
      </div>`,
    );

    await screenshot(page, 'failure-card-cancelled');
    await assertNoOverflow(page);
  });
});
