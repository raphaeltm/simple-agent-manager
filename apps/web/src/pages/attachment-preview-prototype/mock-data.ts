/**
 * Stress-test attachments for the composer attachment-preview prototype.
 *
 * Every attachment is a real `File` built in the browser (canvas-drawn images, generated
 * text, junk binary bytes), so thumbnails, object URLs and text sniffing go through the
 * same code paths a user's real upload would. PROTOTYPE ONLY — never ship.
 */
import type { ProjectChatComposerAttachment } from '../../components/project-chat/ProjectChatComposer';

export interface ProtoAttachment extends ProjectChatComposerAttachment {
  id: string;
}

export type ScenarioId =
  | 'typical'
  | 'single-image'
  | 'single-paste'
  | 'images'
  | 'text'
  | 'everything'
  | 'names'
  | 'states';

export const SCENARIOS: { id: ScenarioId; label: string }[] = [
  { id: 'typical', label: 'Typical (screenshot + paste + PDF)' },
  { id: 'single-image', label: 'One screenshot' },
  { id: 'single-paste', label: 'One long paste' },
  { id: 'images', label: 'Image edge cases (9)' },
  { id: 'text', label: 'Text edge cases (8)' },
  { id: 'everything', label: 'Every type (28)' },
  { id: 'names', label: 'Hostile file names' },
  { id: 'states', label: 'Uploading / failed' },
];

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

function canvasFile(
  name: string,
  type: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  quality?: number
): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  draw(ctx, width, height);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], name, { type })) : reject(new Error(name))),
      type,
      quality
    );
  });
}

function drawAppScreenshot(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#e9f3ec');
  bg.addColorStop(1, '#c9dccf');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const pane = (x: number, y: number, pw: number, ph: number) => {
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, pw, ph, 28);
    ctx.fill();
  };
  pane(40, 40, w * 0.24, h - 80);
  pane(w * 0.24 + 70, 40, w * 0.76 - 110, h * 0.72);
  pane(w * 0.24 + 70, h * 0.72 + 70, w * 0.76 - 110, h * 0.28 - 110);
  ctx.fillStyle = '#1d2b22';
  ctx.font = `600 ${Math.round(h * 0.045)}px system-ui`;
  ctx.fillText('Opus 5.5 Chat', w * 0.24 + 120, 130);
  ctx.fillStyle = '#9db3a5';
  for (let i = 0; i < 9; i++) {
    ctx.fillRect(w * 0.24 + 120, 190 + i * 52, (w * 0.5 * ((i * 37) % 100)) / 100 + 180, 18);
    ctx.fillRect(80, 140 + i * 70, w * 0.16, 22);
  }
  ctx.fillStyle = '#2f7d4f';
  ctx.beginPath();
  ctx.roundRect(w - 220, h - 150, 130, 60, 16);
  ctx.fill();
}

function drawPanorama(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#f6a85b');
  sky.addColorStop(1, '#6a4c93');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#2b2140';
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 80) ctx.lineTo(x, h * 0.45 + Math.sin(x / 210) * h * 0.25);
  ctx.lineTo(w, h);
  ctx.fill();
}

function drawPhoneScreenshot(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#0f1a14';
  ctx.fillRect(0, 0, w, h);
  for (let y = 60, i = 0; y < h - 80; y += 140, i++) {
    const mine = i % 2 === 0;
    ctx.fillStyle = mine ? '#2f7d4f' : '#24332a';
    ctx.beginPath();
    ctx.roundRect(mine ? w * 0.3 : 20, y, w * 0.68, 100, 22);
    ctx.fill();
  }
}

function drawLogo(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(47,125,79,1)');
  g.addColorStop(1, 'rgba(47,125,79,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${w * 0.38}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', w / 2, h / 2);
}

function drawPhoto(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const p = i / 4;
    const x = p % w;
    const y = Math.floor(p / w);
    const n = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
    img.data[i] = 90 + (x / w) * 120 + n * 30;
    img.data[i + 1] = 120 + (y / h) * 80 + n * 30;
    img.data[i + 2] = 80 + n * 60;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

const SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">
<rect width="240" height="120" rx="18" fill="#2f7d4f"/><text x="120" y="72" font-size="40" text-anchor="middle" fill="white" font-family="system-ui">SVG</text>
<script>alert('svg script must never run')</script></svg>`;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['INFO', 'DEBUG', 'WARN', 'ERROR'];
function logText(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const ms = String(i % 1000).padStart(3, '0');
    const level = LOG_LEVELS[i % 7 === 0 ? 3 : i % 3];
    out.push(
      `2026-11-07T14:${String(8 + Math.floor(i / 3600) % 50).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.${ms}Z ${level} vm-agent session_host.go:${400 + (i % 90)} prompt turn=${i} workspace=01M6V23DAHJT3Z05XM2X81SFKJ bytes=${(i * 7919) % 65536} msg="flushing message outbox batch"`
    );
  }
  return out.join('\n');
}

const PROSE = `# Notes from the call

I think that UI should allow you to override things like the model and the effort level
without leaving the chat. A few things that came up:

- The attachment chip should show a preview for images.
- Long pastes become a .txt file — but you can't see what's in it before sending.
- Other uploads should get an icon of some sort.

> "If I paste the wrong log I only find out after the agent has read it."

Right-to-left check: שלום עולם — مرحبا بالعالم. Emoji: 🧪🖼️📎. HTML entities stay literal: &lt;b&gt; <b>not bold</b> <script>alert(1)</script>
`;

function minifiedJson(targetBytes: number): string {
  const items: string[] = [];
  let size = 0;
  for (let i = 0; size < targetBytes; i++) {
    const item = `{"id":"01M6V2${String(i).padStart(8, '0')}","status":"${i % 3 ? 'complete' : 'error'}","sizeBytes":${i * 1031},"tags":["a","b"],"nested":{"x":${i},"y":[1,2,3]}}`;
    items.push(item);
    size += item.length + 1;
  }
  return `{"attachments":[${items.join(',')}]}`;
}

const CODE = `import { useEffect, useState } from 'react';

/** Object URL for a file, revoked when the file changes or the component unmounts. */
export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}
`;

const CSV = ['date,provider,region,vcpu,memory_gb,hourly_eur']
  .concat(
    Array.from({ length: 400 }, (_, i) =>
      [`2026-11-${String((i % 28) + 1).padStart(2, '0')}`, i % 2 ? 'hetzner' : 'gcp', 'fsn1', 2 + (i % 4) * 2, 4 + (i % 4) * 4, (0.012 * (1 + (i % 4))).toFixed(4)].join(',')
    )
  )
  .join('\n');

const DOCKERFILE = `FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "start"]
`;

// ---------------------------------------------------------------------------
// Binary junk (headers are realistic, the rest is filler)
// ---------------------------------------------------------------------------

function binaryFile(name: string, type: string, header: string, sizeBytes: number): File {
  const chunk = new Uint8Array(64 * 1024);
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 2654435761) & 0xff;
  const head = new TextEncoder().encode(header);
  const parts: BlobPart[] = [head];
  let remaining = Math.max(0, sizeBytes - head.length);
  while (remaining > 0) {
    const n = Math.min(remaining, chunk.length);
    parts.push(n === chunk.length ? chunk : chunk.slice(0, n));
    remaining -= n;
  }
  return new File(parts, name, { type });
}

const text = (name: string, body: string, type = 'text/plain') => new File([body], name, { type });

const LONG_NAME = `Screenshot_${'quarterly-infrastructure-cost-review-for-the-compute-pool-migration'.repeat(3)}_FINAL_v2_(1).png`;

export async function buildMockAttachments(): Promise<Record<ScenarioId, ProtoAttachment[]>> {
  const [screenshot, panorama, phone, logo, tiny, photo, longNamed, hostileNamed, oneChar] =
    await Promise.all([
      canvasFile('CleanShot_2026-11-07_at_14.08.18_2x.png', 'image/png', 1600, 1000, drawAppScreenshot),
      canvasFile('panorama-fsn1-datacenter.jpg', 'image/jpeg', 4000, 320, drawPanorama, 0.8),
      canvasFile('IMG_4021.PNG', 'image/png', 390, 2400, drawPhoneScreenshot),
      canvasFile('logo-transparent.png', 'image/png', 512, 512, drawLogo),
      canvasFile('pixel.png', 'image/png', 3, 3, (c) => {
        c.fillStyle = '#d9534f';
        c.fillRect(0, 0, 3, 3);
      }),
      canvasFile('DSC_0042.jpg', 'image/jpeg', 3000, 2000, drawPhoto, 0.92),
      canvasFile(LONG_NAME, 'image/png', 800, 500, drawAppScreenshot),
      canvasFile('תמונה 🎉 <img src=x onerror=alert(1)>.png', 'image/png', 600, 600, drawLogo),
      canvasFile('a', 'image/png', 200, 200, drawLogo),
    ]);

  const corruptPng = binaryFile('broken-export.png', 'image/png', 'not really a png', 48_213);
  const heic = binaryFile('IMG_5530.HEIC', 'image/heic', 'ftypheic', 2_480_000);
  const svg = text('diagram.svg', SVG_SOURCE, 'image/svg+xml');

  // The composer names long pastes `pasted-<epoch ms>.txt` (ProjectChatComposer onPaste).
  const pastedLog = text('pasted-1794057131479.txt', logText(900));
  const pastedHuge = text('pasted-1794057299001.txt', logText(14_000));
  const pastedProse = text('pasted-1794057400123.txt', PROSE.repeat(6));
  const minJson = text('pasted-1794057500777.txt', minifiedJson(300_000));
  const notes = text('meeting-notes.md', PROSE, 'text/markdown');
  const code = text('useObjectUrl.ts', CODE, '');
  const csv = text('compute-costs-2026-11.csv', CSV, 'text/csv');
  const dockerfile = text('Dockerfile', DOCKERFILE, '');
  const empty = text('empty.txt', '');

  const pdf = binaryFile('SAM-architecture-overview.pdf', 'application/pdf', '%PDF-1.7\n', 1_840_000);
  const zip = binaryFile('workspace-snapshot.zip', 'application/zip', 'PK\u0003\u0004', 12_400_000);
  const xlsx = binaryFile(
    'budget.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'PK\u0003\u0004',
    96_000
  );
  const mp4 = binaryFile('screen-recording.mp4', 'video/mp4', '\u0000\u0000\u0000\u0018ftypmp42', 31_000_000);
  const mp3 = binaryFile('voice-memo.m4a', 'audio/mp4', '\u0000\u0000\u0000 ftypM4A ', 3_200_000);
  const core = binaryFile('core', '', '\u007fELF\u0002\u0001\u0001\u0000', 640_000);
  const bin = binaryFile('firmware.bin', 'application/octet-stream', '\u0000\u0001\u0002', 2_048);
  const tarball = binaryFile('logs-2026-11-07.tar.gz', 'application/gzip', '\u001f\u008b', 5_400_000);

  let seq = 0;
  const a = (file: File, over: Partial<ProtoAttachment> = {}): ProtoAttachment => ({
    id: `mock-${seq++}`,
    file,
    progress: 100,
    status: 'complete',
    ...over,
  });

  const images = [screenshot, panorama, phone, logo, tiny, photo, svg, corruptPng, heic];
  const texts = [pastedLog, pastedHuge, pastedProse, minJson, notes, code, csv, dockerfile, empty];
  const others = [pdf, zip, xlsx, mp4, mp3, core, bin, tarball];

  return {
    typical: [a(screenshot), a(pastedLog), a(pdf)],
    'single-image': [a(screenshot)],
    'single-paste': [a(pastedLog)],
    images: images.map((f) => a(f)),
    text: texts.slice(0, 8).map((f) => a(f)),
    everything: [...images, ...texts, ...others, longNamed, hostileNamed]
      .slice(0, 28)
      .map((f) => a(f)),
    names: [a(longNamed), a(hostileNamed), a(oneChar), a(pastedProse), a(text(`${'x'.repeat(180)}.log`, logText(40)))],
    states: [
      a(screenshot, { status: 'uploading', progress: 0 }),
      a(pastedHuge, { status: 'uploading', progress: 42 }),
      a(zip, { status: 'uploading', progress: 99 }),
      a(photo, { status: 'error', progress: 0, error: 'Upload failed: file exceeds the 25 MB limit' }),
      a(mp4, { status: 'error', progress: 0, error: 'Network error — check your connection and retry' }),
      a(logo),
    ],
  };
}
