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

async function renderCrashReportHarness(page: Page) {
  await page.goto('/');
  await page.evaluate(() => {
    document.body.innerHTML = `
      <main style="min-height:100vh;background:var(--sam-color-bg-canvas, #0d0d0d);padding:16px;">
        <div style="max-width:900px;margin:0 auto;">
          <section role="status" aria-label="openai-codex crash report" class="my-3 rounded-lg px-4 py-3 shadow-sm"
            style="border:1px solid color-mix(in srgb, var(--sam-color-warning, #f59e0b) 40%, transparent);background:var(--sam-color-warning-tint, rgba(245,158,11,0.1));color:var(--sam-color-warning-fg, #fbbf24);">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span style="background:var(--sam-color-warning-tint);border:1px solid color-mix(in srgb, var(--sam-color-warning) 40%, transparent);color:var(--sam-color-warning-fg);" class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold">Recovered</span>
                  <span class="text-xs font-medium uppercase opacity-70">Agent crash</span>
                </div>
                <p class="m-0 text-sm font-semibold leading-5" style="color:var(--sam-color-fg-primary, inherit);">The Codex agent crashed unexpectedly. SAM recovered your session automatically. You can continue your conversation with a long follow-up title that wraps cleanly on mobile without pushing the copy action off-screen.</p>
                <p class="m-0 mt-1 text-sm leading-5" style="color:var(--sam-color-fg-secondary, inherit);">This is a bug in Codex, not in SAM.</p>
                <p class="m-0 mt-1 text-sm leading-5" style="color:var(--sam-color-fg-secondary, inherit);">Please report this to OpenAI with the debugging information above.</p>
              </div>
              <button type="button" style="background:var(--sam-color-warning-tint);border:1px solid color-mix(in srgb, var(--sam-color-warning) 40%, transparent);color:var(--sam-color-warning-fg);" class="min-h-11 shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer">Copy report</button>
            </div>
            <details class="mt-3" open>
              <summary class="cursor-pointer text-sm font-medium" style="color:var(--sam-color-warning-fg);">stderr debugging output</summary>
              <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-5" style="background:color-mix(in srgb, var(--sam-color-bg-canvas) 80%, transparent);color:var(--sam-color-fg-secondary);border:1px solid var(--sam-form-border, rgba(255,255,255,0.1));">codex_core::tools::router ERROR: write_stdin failed: stdin is closed for this session
connection closed, peer disconnected
https://example.com/a/very/long/debug/path/that/should/wrap/instead/of/forcing/horizontal/overflow?with=query&and=more&values=abcdefghijklmnopqrstuvwxyz</pre>
            </details>
          </section>

          <section role="status" aria-label="claude-code crash report" class="my-3 rounded-lg px-4 py-3 shadow-sm"
            style="border:1px solid color-mix(in srgb, var(--sam-color-danger, #ef4444) 40%, transparent);background:var(--sam-color-danger-tint, rgba(239,68,68,0.1));color:var(--sam-color-danger-fg, #f87171);">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span style="background:var(--sam-color-danger-tint);border:1px solid color-mix(in srgb, var(--sam-color-danger) 40%, transparent);color:var(--sam-color-danger-fg);" class="inline-flex rounded-full px-2 py-0.5 text-xs font-semibold">Recovery failed</span>
                  <span class="text-xs font-medium uppercase opacity-70">Agent crash</span>
                </div>
                <p class="m-0 text-sm font-semibold leading-5" style="color:var(--sam-color-fg-primary, inherit);">The Claude Code agent crashed unexpectedly. SAM could not recover the session automatically.</p>
                <p class="m-0 mt-1 text-sm leading-5" style="color:var(--sam-color-fg-secondary, inherit);">This is a bug in Claude Code, not in SAM.</p>
                <p class="m-0 mt-1 text-sm leading-5" style="color:var(--sam-color-fg-secondary, inherit);">Please report this to Anthropic with the debugging information above.</p>
                <p class="m-0 mt-2 text-xs font-mono leading-5 break-words" style="color:var(--sam-color-danger-fg);">Recovery error: ACP LoadSession failed: connection reset by peer</p>
              </div>
              <button type="button" style="background:var(--sam-color-danger-tint);border:1px solid color-mix(in srgb, var(--sam-color-danger) 40%, transparent);color:var(--sam-color-danger-fg);" class="min-h-11 shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer">Copy report</button>
            </div>
          </section>
        </div>
      </main>
    `;
  });
}

test.describe('Agent Crash Report Banner', () => {
  test('renders recovery and failure states without mobile overflow', async ({ page }) => {
    await renderCrashReportHarness(page);
    await expect(page.getByText('This is a bug in Codex, not in SAM.')).toBeVisible();
    await expect(page.getByText('Recovery failed')).toBeVisible();

    const copyButton = page.getByRole('button', { name: 'Copy report' }).first();
    const box = await copyButton.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);

    await screenshot(page, 'agent-crash-report-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('Agent Crash Report Banner — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('keeps debugging evidence scannable on desktop', async ({ page }) => {
    await renderCrashReportHarness(page);
    await expect(page.getByText('stderr debugging output')).toBeVisible();
    await expect(page.getByText('ACP LoadSession failed: connection reset by peer')).toBeVisible();

    await screenshot(page, 'agent-crash-report-desktop');
    await assertNoOverflow(page);
  });
});
