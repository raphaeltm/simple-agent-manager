import { deflateSync } from 'node:zlib';

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-preview-v2';
const SESSION_ID = 'sess-preview-v2';
/** Stand-in for the isolated preview origin (`preview.<domain>` in real deployments). */
const PREVIEW_ORIGIN = 'https://preview.example.com';

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
  '%PDF-1.1\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
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
  viewerAccess: 'owner',
  agentType: 'claude-code',
};

function docToolMsg(opts: { id: string; sequence: number; result: Record<string, unknown> }) {
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
  {
    id: 'user-ask',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Show me the preview files.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 0,
  },
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

/** A short real WebM, recorded from a canvas in the browser so no binary fixture is committed. */
async function recordWebm(page: Page): Promise<Buffer> {
  await page.goto('about:blank');
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(15);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
    recorder.start();
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const draw = () => {
        const t = (performance.now() - started) / 1000;
        ctx.fillStyle = '#0b3d2a';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#4ade80';
        ctx.fillRect(40 + t * 300, 140, 80, 80);
        if (t < 1.2) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    recorder.stop();
    await done;
    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return Buffer.from(base64, 'base64');
}

const VIDEO_LINKS = {
  sessions: {
    items: [
      {
        sessionId: 'sess-uploader',
        topic: 'Create and upload mobile chat info prototypes to library',
        status: 'sleeping',
        relations: ['uploaded'],
        lastActivityAt: null,
        taskId: null,
      },
      {
        sessionId: 'sess-viewer',
        topic: 'Review the prototypes',
        status: 'sleeping',
        relations: ['viewed'],
        lastActivityAt: null,
        taskId: null,
      },
    ],
    total: 2,
    truncated: false,
    totalIsLowerBound: false,
  },
  ideas: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
};

const LONG_ZIP_NAME =
  'release-bundle-with-a-very-long-name-that-an-agent-produced-for-the-weekly-recap-2026-11-04-final-v2.zip';

/** A second conversation, so the virtualized list keeps every card above in view. */
const MEDIA_MESSAGES = [
  docToolMsg({
    id: 'video-file',
    sequence: 1,
    result: {
      fileId: 'video-file',
      filename: 'prototype-a-one-line.webm',
      // Stored as octet-stream, as cf-container agent uploads are: the extension recovers it.
      mimeType: 'application/octet-stream',
      sizeBytes: 868_000,
    },
  }),
  docToolMsg({
    id: 'other-file',
    sequence: 2,
    result: {
      fileId: 'other-file',
      filename: LONG_ZIP_NAME,
      mimeType: 'application/zip',
      sizeBytes: 4_200_000,
    },
  }),
];

async function setupMocks(page: Page, messages = MOCK_MESSAGES) {
  const videoBytes = await recordWebm(page);

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
    if (path === `/api/projects/${PROJECT_ID}/library/video-file/preview`) {
      return route.fulfill({ status: 200, contentType: 'video/webm', body: videoBytes });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/video-file/comments`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ threads: [] }),
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/video-file/links`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VIDEO_LINKS),
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/html-file/preview`) {
      return route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: HTML_BODY,
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/library/html-file/interactive-preview-url`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: `${PREVIEW_ORIGIN}/p/signed/index.html`,
          expiresAt: '2026-08-04T12:05:00.000Z',
          version: '2026-07-04T00:00:00Z',
        }),
      });
    }
    // The isolated preview origin the auto-run iframe points at.
    if (route.request().url().startsWith(PREVIEW_ORIGIN)) {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: HTML_BODY,
      });
    }
    return route.fallback();
  });

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
  });
}

/**
 * The conversation is virtualized and opens at its newest message, so a card may not be
 * mounted until the list scrolls to it. Wheel up, then down, until it is.
 */
async function revealCard(page: Page, fileName: string) {
  const card = page.getByRole('button', { name: `Open ${fileName}` });
  const log = page.getByRole('log', { name: 'Conversation' });
  await log.hover();
  for (const step of [-300, 300]) {
    for (let i = 0; i < 15; i += 1) {
      if (await card.isVisible()) return card;
      await page.mouse.wheel(0, step);
      await page.waitForTimeout(150);
    }
  }
  await expect(card).toBeVisible();
  return card;
}

async function openModalAndCapture(page: Page, fileName: string, screenshotName: string) {
  await (await revealCard(page, fileName)).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: fileName })).toBeVisible();
  await expect(page.getByText('Failed to load image')).toHaveCount(0);
  if (fileName.endsWith('.html')) {
    // Opening the artifact IS the intent signal — the preview must already be running, with the
    // isolation contract intact and no leftover inert copy above it.
    const frame = page.locator(`iframe[title="Interactive preview of ${fileName}"]`);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('dialog').locator('iframe')).toHaveCount(1);
    // The dead flex chain pinned this to its 320px min-height floor at every viewport.
    const box = await frame.boundingBox();
    const viewport = page.viewportSize();
    expect(box!.height).toBeGreaterThan(viewport!.height * 0.5);
  }
  if (fileName.match(/\.(png|jpe?g|gif|webp|svg)$/i)) {
    const previewImage = page.getByRole('dialog').locator(`img[alt="${fileName}"]`);
    await expect
      .poll(() =>
        previewImage.evaluate((img: HTMLImageElement) => ({
          display: getComputedStyle(img).display,
          naturalHeight: img.naturalHeight,
          naturalWidth: img.naturalWidth,
        }))
      )
      .toEqual({ display: 'block', naturalHeight: 360, naturalWidth: 640 });
  }
  if (fileName.endsWith('.webm')) {
    const video = page.getByTestId('video-preview');
    await expect(video).toBeVisible();
    // It actually decoded: metadata loaded and it has a picture.
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.videoWidth))
      .toBe(640);
    // The artifact gets the screen: the pane holding it fills most of the viewport.
    const pane = await page.getByRole('region', { name: `Preview of ${fileName}` }).boundingBox();
    const viewport = page.viewportSize()!;
    expect(pane!.height).toBeGreaterThan(viewport.height * 0.8);
    expect(pane!.width).toBeGreaterThan(viewport.width * 0.9);
    // Provenance lives on the header's meta line, and expands as a popover over the artifact.
    const toggle = page.getByTestId('file-linked-work-toggle');
    await expect(toggle).toContainText('Uploaded by Create and upload');
    await toggle.click();
    await expect(page.getByTestId('file-linked-chat')).toHaveCount(2);
    await page.waitForTimeout(400);
    await screenshot(page, `${screenshotName}-linked-work`);
    await assertNoOverflow(page);
    await toggle.click();
    await expect(page.getByTestId('file-linked-chat')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show comments' }).click();
    await expect(page.getByRole('complementary', { name: 'File comments' })).toBeVisible();
    await expect(page.getByText('No comments on this file yet.')).toBeVisible();
    await page.waitForTimeout(400);
    await screenshot(page, `${screenshotName}-comments`);
    await assertNoOverflow(page);
    await page.getByRole('button', { name: 'Hide comments' }).click();
  }
  if (fileName.endsWith('.zip')) {
    await expect(page.getByText(/no preview for this file type/i)).toBeVisible();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true })
    ).toBeVisible();
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

  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible();

  await openModalAndCapture(page, 'architecture-diagram.png', `file-preview-image-${suffix}`);
  await openModalAndCapture(page, 'preview-notes.md', `file-preview-markdown-${suffix}`);
  await openModalAndCapture(page, 'preview-contract.pdf', `file-preview-pdf-${suffix}`);
  await openModalAndCapture(page, 'interactive-preview.html', `file-preview-html-${suffix}`);
}

async function runMediaAudit(page: Page, suffix: string) {
  await setupMocks(page, MEDIA_MESSAGES);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await openModalAndCapture(page, 'prototype-a-one-line.webm', `file-preview-video-${suffix}`);
  await openModalAndCapture(page, LONG_ZIP_NAME, `file-preview-unsupported-${suffix}`);
}

test.describe('File Preview Modal', () => {
  test('opens image, markdown, PDF, and HTML previews edge-to-edge', async ({ page }) => {
    const viewport = page.viewportSize();
    const suffix = viewport?.width === 375 ? 'mobile' : 'desktop';
    await runAudit(page, suffix);
  });

  test('plays a video, and offers the download for a type it cannot show', async ({ page }) => {
    const viewport = page.viewportSize();
    const suffix = viewport?.width === 375 ? 'mobile' : 'desktop';
    await runMediaAudit(page, suffix);
  });
});
