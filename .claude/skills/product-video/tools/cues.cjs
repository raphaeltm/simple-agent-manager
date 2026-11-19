// Dump the scene's cue sheet (film seconds) as JSON, for audio placement.
const path = require('path');
const { chromium } = require(
  path.join(process.env.PLAYWRIGHT_DIR || '/tmp/render', 'node_modules/playwright')
);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(process.argv[2]));
  console.log(JSON.stringify(await p.evaluate(() => cueSheet())));
  await b.close();
})();
