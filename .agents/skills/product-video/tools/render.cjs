// Deterministic frame renderer: scene.html exposes window.setTime(seconds).
// Usage:
//   node render.cjs <scene.html> --stills 3,12.5,40   -> stills/frame-<t>.png
//   node render.cjs <scene.html> --video out.mp4 --duration 91 [--fps 30]
// Needs: playwright (Chromium) and ffmpeg on PATH. Set PLAYWRIGHT_DIR to the folder holding node_modules/playwright.
const path = require('path');
const cp = require('child_process');
const fs = require('fs');
const { chromium } = require(
  path.join(process.env.PLAYWRIGHT_DIR || '/tmp/render', 'node_modules/playwright')
);

const args = process.argv.slice(2);
const scene = path.resolve(args[0]);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

(async () => {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  page.on('pageerror', (e) => {
    console.error('PAGE ERROR', e.message);
    process.exitCode = 1;
  });
  await page.goto('file://' + scene);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((i) =>
        i.complete
          ? 1
          : new Promise((r) => {
              i.onload = r;
              i.onerror = r;
            })
      )
    )
  );
  const dir = path.dirname(scene);

  const stills = opt('--stills');
  if (stills) {
    fs.mkdirSync(path.join(dir, 'stills'), { recursive: true });
    for (const t of stills.split(',').map(Number)) {
      await page.evaluate((t) => setTime(t), t);
      await page.screenshot({ path: path.join(dir, 'stills', `frame-${t.toFixed(2)}.png`) });
    }
    await browser.close();
    return;
  }

  const out = path.resolve(opt('--video', path.join(dir, 'silent.mp4')));
  const fps = Number(opt('--fps', 30)),
    dur = Number(opt('--duration', 10));
  const n = Math.round(dur * fps);
  const enc = cp.spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-framerate',
      String(fps),
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] }
  );
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => setTime(t), i / fps);
    const jpg = await page.screenshot({ type: 'jpeg', quality: 93 });
    if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${n}`);
  }
  enc.stdin.end();
  await new Promise((res, rej) =>
    enc.on('exit', (c) => (c ? rej(new Error('ffmpeg ' + c)) : res()))
  );
  await browser.close();
})();
