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
      <main style="min-height:100vh;background:#f8fafc;padding:16px;">
        <div style="max-width:900px;margin:0 auto;">
          <section role="status" aria-label="openai-codex crash report" class="my-3 rounded-lg border px-4 py-3 shadow-sm border-amber-300 bg-amber-50 text-amber-950">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span style="background-color:#fef3c7;border-color:#fbbf24;color:#92400e;" class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold">Recovered</span>
                  <span class="text-xs font-medium uppercase text-current opacity-70">Agent crash</span>
                </div>
                <p class="m-0 text-sm font-semibold leading-5">The Codex agent crashed unexpectedly. SAM recovered your session automatically. You can continue your conversation with a long follow-up title that wraps cleanly on mobile without pushing the copy action off-screen.</p>
                <p class="m-0 mt-1 text-sm leading-5">This is a bug in Codex, not in SAM.</p>
                <p class="m-0 mt-1 text-sm leading-5">Please report this to OpenAI with the debugging information above.</p>
              </div>
              <button type="button" style="background-color:#fffbeb;border-color:#f59e0b;color:#78350f;" class="min-h-11 shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:brightness-95">Copy report</button>
            </div>
            <details class="mt-3" open>
              <summary class="cursor-pointer text-sm font-medium">stderr debugging output</summary>
              <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-black/10 bg-white/75 p-3 text-xs leading-5 text-slate-900">codex_core::tools::router ERROR: write_stdin failed: stdin is closed for this session
connection closed, peer disconnected
https://example.com/a/very/long/debug/path/that/should/wrap/instead/of/forcing/horizontal/overflow?with=query&and=more&values=abcdefghijklmnopqrstuvwxyz</pre>
            </details>
          </section>

          <section role="status" aria-label="claude-code crash report" class="my-3 rounded-lg border px-4 py-3 shadow-sm border-red-300 bg-red-50 text-red-950">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="mb-2 flex flex-wrap items-center gap-2">
                  <span style="background-color:#fee2e2;border-color:#fca5a5;color:#991b1b;" class="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold">Recovery failed</span>
                  <span class="text-xs font-medium uppercase text-current opacity-70">Agent crash</span>
                </div>
                <p class="m-0 text-sm font-semibold leading-5">The Claude Code agent crashed unexpectedly. SAM could not recover the session automatically.</p>
                <p class="m-0 mt-1 text-sm leading-5">This is a bug in Claude Code, not in SAM.</p>
                <p class="m-0 mt-1 text-sm leading-5">Please report this to Anthropic with the debugging information above.</p>
                <p class="m-0 mt-2 text-xs font-mono leading-5 break-words">Recovery error: ACP LoadSession failed: connection reset by peer</p>
              </div>
              <button type="button" style="background-color:#fef2f2;border-color:#ef4444;color:#7f1d1d;" class="min-h-11 shrink-0 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:brightness-95">Copy report</button>
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
