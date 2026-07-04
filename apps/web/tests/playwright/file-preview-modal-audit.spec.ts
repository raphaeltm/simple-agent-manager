import { deflateSync } from 'node:zlib';

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-preview-v2';
const SESSION_ID = 'sess-preview-v2';

test.use({ serviceWorkers: 'block' });

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = 17;
      raw[offset + 1] = 51 + Math.floor((x / width) * 120);
      raw[offset + 2] = 44 + Math.floor((y / height) * 120);
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
  ]);
}

const IMAGE_BYTES = createPng(640, 360);

const PDF_BYTES = Buffer.from(
  '%PDF-1.1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF',
);

const MARKDOWN_BODY = [
  '# Preview v2 markdown',
  '',
  'This modal should occupy the full viewport without horizontal overflow.',
  '',
  '| Column | Value |',
  '| --- | --- |',
  '| Long text | A very long markdown table value that should wrap instead of pushing the modal wider than the viewport. |',
].join('\n');

const HTML_BODY = `<!doctype html>
<html>
  <body style="font: 16px system-ui; margin: 24px; background: white; color: #111">
    <h1>Interactive HTML</h1>
    <button id="run" style="min-height:44px">Run script</button>
    <pre id="out">waiting</pre>
    <script>
      document.getElementById('run').click();
      let cookieResult = 'blocked';
      try {
        cookieResult = document.cookie || 'empty';
      } catch (err) {
        cookieResult = 'blocked';
      }
      document.getElementById('out').textContent = 'script ran; cookie=' + cookieResult;
    </script>
  </body>
</html>`;

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'File Preview v2 Audit',
  repository: 'user/file-preview-v2',
  repoProvider: 'github',
  createdAt: '2026-07-04T00:00:00Z',
  updatedAt: '2026-07-04T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Preview modal audit',
  status: 'stopped',
  messageCount: 5,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

function docToolMsg(opts: {
  id: string;
  sequence: number;
  result: Record<string, unknown>;
}) {
  return {
    id: opts.id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: opts.id,
      status: 'completed',
      toolName: 'mcp__sam-mcp__display_from_library',
      rawInput: { fileId: opts.id },
      rawOutput: [{ type: 'text', text: JSON.stringify(opts.result) }],
    },
    createdAt: Date.now() - 40_000 + opts.sequence * 1000,
    sequence: opts.sequence,
  };
}

const MOCK_MESSAGES = [
  docToolMsg({
    id: 'image-file',
    sequence: 1,
    result: {
      fileId: 'image-file',
      filename: 'architecture-diagram.png',
      mimeType: 'image/png',
      sizeBytes: IMAGE_BYTES.length,
    },
  }),
  docToolMsg({
    id: 'markdown-file',
    sequence: 2,
    result: {
      fileId: 'markdown-file',
      filename: 'preview-notes.md',
      mimeType: 'text/markdown',
      sizeBytes: MARKDOWN_BODY.length,
    },
  }),
  docToolMsg({
    id: 'pdf-file',
    sequence: 3,
    result: {
      fileId: 'pdf-file',
      filename: 'preview-contract.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF_BYTES.length,
    },
  }),
  docToolMsg({
    id: 'html-file',
    sequence: 4,
    result: {
      fileId: 'html-file',
      filename: 'interactive-preview.html',
      mimeType: 'text/html',
      sizeBytes: HTML_BODY.length,
    },
  }),
];

async function setupMocks(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });

  await page.route('**/*', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/api/projects/${PROJECT_ID}/library/image-file/preview`) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: IMAGE_BYTES });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/markdown-file/preview`) {
      return route.fulfill({ status: 200, contentType: 'text/markdown', body: MARKDOWN_BODY });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/pdf-file/preview`) {
      return route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF_BYTES });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/html-file/preview`) {
      return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: HTML_BODY });
    }
    return route.fallback();
  });

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: MOCK_MESSAGES,
  });
}

async function openModalAndCapture(page: Page, fileName: string, screenshotName: string) {
  await page.getByRole('button', { name: `Open ${fileName}` }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: fileName })).toBeVisible();
  await expect(page.getByText('Failed to load image')).toHaveCount(0);
  if (fileName.match(/\.(png|jpe?g|gif|webp|svg)$/i)) {
    const previewImage = page.getByRole('dialog').locator(`img[alt="${fileName}"]`);
    await expect
      .poll(() =>
        previewImage.evaluate((img: HTMLImageElement) => ({
          display: getComputedStyle(img).display,
          naturalHeight: img.naturalHeight,
          naturalWidth: img.naturalWidth,
        })),
      )
      .toEqual({ display: 'block', naturalHeight: 360, naturalWidth: 640 });
  }
  await page.waitForTimeout(700);
  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
  await page.getByRole('button', { name: 'Close preview' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

async function runAudit(page: Page, suffix: string) {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  await expect(page.getByRole('button', { name: 'Open architecture-diagram.png' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview-notes.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open preview-contract.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open interactive-preview.html' })).toBeVisible();

  await openModalAndCapture(page, 'architecture-diagram.png', `file-preview-image-${suffix}`);
  await openModalAndCapture(page, 'preview-notes.md', `file-preview-markdown-${suffix}`);
  await openModalAndCapture(page, 'preview-contract.pdf', `file-preview-pdf-${suffix}`);
  await openModalAndCapture(page, 'interactive-preview.html', `file-preview-html-${suffix}`);
}

test.describe('File Preview Modal', () => {
  test('opens image, markdown, PDF, and HTML previews edge-to-edge', async ({ page }) => {
    const viewport = page.viewportSize();
    const suffix = viewport?.width === 375 ? 'mobile' : 'desktop';
    await runAudit(page, suffix);
  });
});
