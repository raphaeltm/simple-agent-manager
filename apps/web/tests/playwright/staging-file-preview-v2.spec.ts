/**
 * Staging verification for File Preview v2.
 *
 * Uses the deployed staging app and real staging library upload/preview routes.
 * Only the project-chat session payload is mocked so the uploaded files appear
 * as DocumentCards without requiring a live agent run.
 */
import { deflateSync } from 'node:zlib';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const PROJECT_ID = '01KJVGMWX26SGQ5DX94GMTJRQN';
const SESSION_ID = 'file-preview-v2-staging-session';

const HTML_FIXTURE = `<!doctype html>
<html>
  <body>
    <h1>Interactive HTML</h1>
    <button id="run">Run script</button>
    <pre id="result">not run</pre>
    <script>
      function mark() {
        let cookieResult = 'blocked';
        try {
          cookieResult = document.cookie || 'blocked';
        } catch (err) {
          cookieResult = 'blocked';
        }
        document.getElementById('result').textContent =
          'script ran; cookie=' + cookieResult;
      }
      document.getElementById('run').addEventListener('click', mark);
      mark();
    </script>
  </body>
</html>`;

function pngChunk(type: string, data: Buffer): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      raw[i] = Math.round((x / width) * 255);
      raw[i + 1] = Math.round((y / height) * 255);
      raw[i + 2] = 180;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function login(request: APIRequestContext) {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER env var not set');
  const loginResp = await request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(loginResp.status()).toBe(200);
}

async function uploadFixture(
  request: APIRequestContext,
  filename: string,
  mimeType: string,
  buffer: Buffer,
) {
  const resp = await request.post(`${STAGING_API}/api/projects/${PROJECT_ID}/library/upload`, {
    multipart: {
      file: { name: filename, mimeType, buffer },
      filename,
      mimeType,
      tags: 'staging,file-preview-v2',
    },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()) as { id: string; filename: string; mimeType: string; sizeBytes: number };
}

function docToolMessage(file: { id: string; filename: string; mimeType: string; sizeBytes: number }, sequence: number) {
  return {
    id: `tool-${file.id}`,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: `tool-${file.id}`,
      status: 'completed',
      toolName: 'mcp__sam-mcp__upload_to_library',
      rawInput: { filePath: `/tmp/${file.filename}` },
      rawOutput: [{
        type: 'text',
        text: JSON.stringify({
          fileId: file.id,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }),
      }],
    },
    createdAt: Date.now() - 30_000 + sequence * 1000,
    sequence,
  };
}

async function setupChat(page: Page, htmlFile: Awaited<ReturnType<typeof uploadFixture>>, imageFile: Awaited<ReturnType<typeof uploadFixture>>) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: {
      id: PROJECT_ID,
      name: 'File Preview v2 Staging',
      repository: 'raphaeltm/simple-agent-manager',
      repoProvider: 'github',
      createdAt: '2026-07-04T00:00:00Z',
      updatedAt: '2026-07-04T00:00:00Z',
    },
    session: {
      id: SESSION_ID,
      workspaceId: null,
      taskId: null,
      topic: 'File Preview v2 staging',
      status: 'stopped',
      messageCount: 3,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 10_000,
      endedAt: Date.now() - 10_000,
      cleanupAt: null,
      isIdle: false,
      agentCompletedAt: null,
      agentSessionId: null,
      agentType: 'openai-codex',
    },
    messages: [
      {
        id: 'user-file-preview-v2',
        sessionId: SESSION_ID,
        role: 'user',
        content: 'Show the interactive HTML and image preview fixtures.',
        toolMetadata: null,
        createdAt: Date.now() - 50_000,
        sequence: 1,
      },
      docToolMessage(htmlFile, 2),
      docToolMessage(imageFile, 3),
    ],
  });
}

test.describe('File Preview v2 staging', () => {
  test('opens real uploaded HTML from a DocumentCard in an inert sandbox and pinch-zooms image preview', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page.request);
    await page.addInitScript(() => {
      localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
      localStorage.setItem('sam-onboarding-wizard-dismissed-user', 'true');
    });

    const timestamp = Date.now();
    const htmlFile = await uploadFixture(
      page.request,
      `file-preview-v2-${timestamp}.html`,
      'text/html',
      Buffer.from(HTML_FIXTURE),
    );
    const imageFile = await uploadFixture(
      page.request,
      `file-preview-v2-${timestamp}.png`,
      'image/png',
      makePng(640, 360),
    );

    const htmlPreview = await page.request.get(`${STAGING_API}/api/projects/${PROJECT_ID}/library/${htmlFile.id}/preview`);
    const htmlPreviewBody = await htmlPreview.text();
    expect(
      htmlPreview.status(),
      `HTML preview failed for ${JSON.stringify(htmlFile)} with body: ${htmlPreviewBody}`,
    ).toBe(200);
    expect(htmlPreview.headers()['content-type']).toBe('text/plain; charset=utf-8');
    expect(htmlPreview.headers()['content-type']).not.toContain('text/html');
    expect(htmlPreview.headers()['content-security-policy']).toBe("default-src 'none'");

    await setupChat(page, htmlFile, imageFile);
    const previewResponses: Array<{ status: number; url: string; body: string }> = [];
    page.on('response', async (response) => {
      if (!response.url().includes(`/library/${htmlFile.id}/preview`)) return;
      let body = '';
      try {
        body = (await response.text()).slice(0, 300);
      } catch {
        body = '<unreadable>';
      }
      previewResponses.push({ status: response.status(), url: response.url(), body });
    });
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${SESSION_ID}`, { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: `Open ${htmlFile.filename}` }).click();
    await expect
      .poll(() => previewResponses.map((r) => `${r.status} ${r.body}`).join('\n'))
      .toContain('200 ');
    const frame = page.locator(`iframe[title="${htmlFile.filename}"]`);
    await expect(frame).toHaveAttribute('sandbox', '');
    await expect(frame).toHaveAttribute('srcdoc', /Interactive HTML/);
    await expect(frame).not.toHaveAttribute('srcdoc', /<script/i);
    await expect(page.frameLocator(`iframe[title="${htmlFile.filename}"]`).locator('#result')).toHaveText('not run');
    await screenshot(page, 'staging-file-preview-v2-html');
    await assertNoOverflow(page);
    await page.getByRole('button', { name: /Close preview/ }).click();

    await page.getByRole('button', { name: `Open ${imageFile.filename}` }).click();
    const imageViewer = page.locator('div[style*="touch-action: none"]').first();
    const image = imageViewer.getByRole('img', { name: imageFile.filename });
    await expect(image).toBeVisible();
    const imageBox = await image.boundingBox();
    expect(imageBox).not.toBeNull();
    const box = imageBox!;
    await imageViewer.dispatchEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      clientX: box.x + box.width / 2 - 30,
      clientY: box.y + box.height / 2,
    });
    await imageViewer.dispatchEvent('pointerdown', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: false,
      bubbles: true,
      clientX: box.x + box.width / 2 + 30,
      clientY: box.y + box.height / 2,
    });
    await imageViewer.dispatchEvent('pointermove', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      clientX: box.x + box.width / 2 - 90,
      clientY: box.y + box.height / 2,
    });
    await imageViewer.dispatchEvent('pointermove', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: false,
      bubbles: true,
      clientX: box.x + box.width / 2 + 90,
      clientY: box.y + box.height / 2,
    });
    await imageViewer.dispatchEvent('pointerup', {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
    });
    await imageViewer.dispatchEvent('pointerup', {
      pointerId: 2,
      pointerType: 'touch',
      isPrimary: false,
      bubbles: true,
    });

    await expect
      .poll(() => image.evaluate((img) => getComputedStyle(img).transform))
      .not.toBe('none');
    await screenshot(page, 'staging-file-preview-v2-image-pinch');
    await assertNoOverflow(page);
  });
});
