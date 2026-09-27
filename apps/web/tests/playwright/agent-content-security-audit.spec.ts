import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

// Agent-written content in a real browser, through the real app: Mermaid in a chat
// message and in a library markdown preview, and a library PDF in the preview modal.
// Nothing the content carries may execute, nothing it names may be fetched from
// another origin, and what it describes must still be drawn.

const PROJECT_ID = 'proj-agent-content';
const SESSION_ID = 'sess-agent-content';
const ATTACKER_HOST = 'evil.example';
const PWN = 'window.__pwned=1';
/** Chromium's built-in PDF viewer loads as this extension frame. */
const CHROMIUM_PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

// Every diagram names a label that must still be visible once it has rendered.
const DIAGRAMS: Array<{ source: string; label: string }> = [
  {
    source: [
      'flowchart TD',
      '  subgraph Pipeline[Build pipeline stage]',
      '    A[Start here] -->|edge label| B["Line one<br>Line two"]',
      '  end',
    ].join('\n'),
    label: 'Build pipeline stage',
  },
  {
    source: `flowchart TD\n  A["<img src=x onerror=${PWN}>"] --> B[Label node]`,
    label: 'Label node',
  },
  {
    source: `%%{init: {"htmlLabels": true}}%%\nflowchart TD\n  A["<img src=x onerror=${PWN}>"] --> B[Directive node]`,
    label: 'Directive node',
  },
  {
    source: `%%{init: {"themeCSS": "background-image: url(https://${ATTACKER_HOST}/theme.png)"}}%%\nflowchart TD\n  A[Theme node] --> B[Theme target]`,
    label: 'Theme node',
  },
  {
    source: `%%{init: {"fontFamily": "x;background-image:url(https://${ATTACKER_HOST}/font.png)"}}%%\nflowchart TD\n  A[Font node] --> B[Font target]`,
    label: 'Font node',
  },
  {
    source: `flowchart TD\n  A[Link node] --> B[Link target]\n  click A "https://${ATTACKER_HOST}/click" _blank`,
    label: 'Link node',
  },
  {
    source: `flowchart TD\n  A["<svg></p><style><a id=#quot;</style><img src=1 onerror=${PWN}>#quot;>"] --> B[Mutation node]`,
    label: 'Mutation node',
  },
];

const DIAGRAM_MARKDOWN = [
  'Diagrams an agent wrote:',
  ...DIAGRAMS.map(({ source }) => ['```mermaid', source, '```'].join('\n')),
].join('\n\n');

/** A minimal, well-formed one-page PDF (correct xref offsets) showing `text`. */
function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const PDF_BYTES = onePagePdf('Quarterly report');

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Agent Content Audit',
  repository: 'user/agent-content-audit',
  repoProvider: 'github',
  createdAt: '2026-09-27T00:00:00Z',
  updatedAt: '2026-09-27T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Agent-written content',
  status: 'stopped',
  messageCount: 1,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

function libraryCard(sequence: number, fileId: string, filename: string, mimeType: string) {
  return {
    id: fileId,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: fileId,
      status: 'completed',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId },
      rawOutput: [
        { type: 'text', text: JSON.stringify({ fileId, filename, mimeType, sizeBytes: 2048 }) },
      ],
    },
    createdAt: Date.now() - 40_000 + sequence * 1000,
    sequence,
  };
}

const DIAGRAMS_MESSAGE = {
  id: 'msg-agent-diagrams',
  sessionId: SESSION_ID,
  role: 'assistant',
  content: DIAGRAM_MARKDOWN,
  toolMetadata: null,
  createdAt: Date.now() - 20_000,
  sequence: 1,
};
const MARKDOWN_CARD = libraryCard(1, 'diagrams-file', 'agent-diagrams.md', 'text/markdown');
const PDF_CARD = libraryCard(1, 'pdf-file', 'quarterly-report.pdf', 'application/pdf');

/**
 * Mock the app's API with a chat holding `messages`, and record every request the
 * page makes to the attacker's host.
 */
async function setupMocks(page: Page, messages: unknown[]): Promise<string[]> {
  const attackerRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === ATTACKER_HOST) attackerRequests.push(request.url());
  });
  await page.route(`https://${ATTACKER_HOST}/**`, (route) => route.fulfill({ status: 204 }));
  await page.route(`**/api/projects/${PROJECT_ID}/library/diagrams-file/preview`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/markdown', body: DIAGRAM_MARKDOWN })
  );
  // The headers /preview sends for a real PDF. The app and this mocked API share an
  // origin here, so 'self' plays the part of https://app.<domain>.
  await page.route(`**/api/projects/${PROJECT_ID}/library/pdf-file/preview`, (route) =>
    route.fulfill({
      status: 200,
      body: PDF_BYTES,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="quarterly-report.pdf"',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; object-src 'self'; frame-ancestors 'self'",
      },
    })
  );
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
  });
  return attackerRequests;
}

/**
 * Everything inside the given diagrams a browser could execute or use to fetch a
 * resource. An empty list means every diagram is inert SVG.
 */
function activeContentIn(page: Page, diagramSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const findings: string[] = [];
    const externalCss = /url\s*\(\s*['"]?\s*(?!#)|image-set\s*\(|@import/i;
    for (const svg of Array.from(document.querySelectorAll(selector))) {
      for (const element of [svg, ...Array.from(svg.querySelectorAll('*'))]) {
        const tag = element.localName;
        if (element.namespaceURI !== 'http://www.w3.org/2000/svg') findings.push(`<${tag}>`);
        for (const { name, value } of Array.from(element.attributes)) {
          if (name.startsWith('xmlns')) continue;
          const isHref = name === 'href' || name === 'xlink:href';
          const allowedHref =
            tag === 'image'
              ? /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value)
              : value.startsWith('#');
          if (/^on/i.test(name) || /javascript:/i.test(value)) findings.push(`<${tag} ${name}>`);
          else if (isHref ? !allowedHref : externalCss.test(value))
            findings.push(`<${tag} ${name}="${value}">`);
        }
        if (tag === 'style' && externalCss.test(element.textContent ?? '')) {
          findings.push(`<style> ${element.textContent}`);
        }
      }
    }
    return findings;
  }, diagramSelector);
}

async function expectDiagramsInertAndDrawn(page: Page, diagramSelector: string) {
  await expect(page.locator(diagramSelector)).toHaveCount(DIAGRAMS.length, { timeout: 30_000 });
  await expect(page.getByTestId('mermaid-diagram-error')).toHaveCount(0);
  for (const { label } of DIAGRAMS) {
    await expect(page.locator(diagramSelector).getByText(label, { exact: true })).toBeVisible();
  }
  expect(await activeContentIn(page, diagramSelector)).toEqual([]);
}

async function expectNothingRanOrLeaked(page: Page, attackerRequests: string[]) {
  expect(await page.evaluate(() => (window as { __pwned?: unknown }).__pwned)).toBeUndefined();
  expect(attackerRequests).toEqual([]);
}

async function openChat(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible();
}

// Full Chromium rather than the default headless shell, which has no PDF viewer and
// downloads PDFs instead of rendering them.
test.use({ channel: 'chromium', serviceWorkers: 'block' });

for (const [viewportName, viewport, isMobile] of [
  ['mobile', { width: 375, height: 667 }, true],
  ['desktop', { width: 1280, height: 800 }, false],
] as const) {
  test.describe(`Agent-written content — ${viewportName}`, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test('Mermaid in a chat message renders as inert SVG with every label drawn', async ({
      page,
    }) => {
      const attackerRequests = await setupMocks(page, [DIAGRAMS_MESSAGE]);
      await openChat(page);

      await expectDiagramsInertAndDrawn(page, '[data-testid="mermaid-diagram-svg"] > svg');
      await expectNothingRanOrLeaked(page, attackerRequests);
      await page.getByText('Build pipeline stage', { exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, `agent-content-chat-mermaid-${viewportName}`);
      await assertNoOverflow(page);
    });

    test('Mermaid in a library markdown preview renders as inert SVG', async ({ page }) => {
      const attackerRequests = await setupMocks(page, [MARKDOWN_CARD]);
      await openChat(page);

      await page.getByRole('button', { name: 'Open agent-diagrams.md' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'agent-diagrams.md' })).toBeVisible();
      await expectDiagramsInertAndDrawn(
        page,
        '[role="dialog"] [data-testid="mermaid-diagram"] > svg'
      );
      await expectNothingRanOrLeaked(page, attackerRequests);
      await screenshot(page, `agent-content-library-mermaid-${viewportName}`);
      await assertNoOverflow(page);
    });
  });

  test.describe(`Library PDF preview — ${viewportName}`, () => {
    test.use({ viewport, isMobile, hasTouch: isMobile });

    test('the preview modal renders the PDF in the browser viewer', async ({ page }) => {
      await setupMocks(page, [PDF_CARD]);
      const blocked: string[] = [];
      page.on('requestfailed', (request) => {
        if (request.url().includes('/library/pdf-file/preview')) {
          blocked.push(request.failure()?.errorText ?? 'failed');
        }
      });
      await openChat(page);

      await page.getByRole('button', { name: 'Open quarterly-report.pdf' }).click();
      const frame = page.getByTitle('Preview of quarterly-report.pdf');
      await expect(frame).toBeVisible();
      // Chromium refuses PDFs in sandboxed frames (net::ERR_BLOCKED_BY_CLIENT).
      await expect(frame).not.toHaveAttribute('sandbox');
      await expect
        .poll(() => page.frames().some((f) => f.url().startsWith(CHROMIUM_PDF_VIEWER)), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(blocked).toEqual([]);
      await page.waitForTimeout(1_500);
      await screenshot(page, `agent-content-library-pdf-${viewportName}`);
      await assertNoOverflow(page);
    });
  });
}
