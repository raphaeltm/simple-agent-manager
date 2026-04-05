import http from 'node:http';

const server = http.createServer((req, res) => {
  const clientIP =
    req.headers['x-forwarded-for'] ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    'unknown';

  const headers = Object.entries(req.headers)
    .map(
      ([key, value]) =>
        `<tr><td style="font-weight:600;padding:6px 12px;border:1px solid #ddd;background:#f8f9fa">${escapeHtml(key)}</td><td style="padding:6px 12px;border:1px solid #ddd;word-break:break-all">${escapeHtml(String(value))}</td></tr>`
    )
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Request Info</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f0f2f5; color: #333; padding: 2rem; }
    .container { max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #1a1a2e; }
    .card { background: #fff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1rem; color: #555; margin-bottom: 1rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .field { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
    .field .label { font-weight: 600; min-width: 100px; }
    .field .value { font-family: 'SF Mono', Monaco, Consolas, monospace; background: #f4f4f4; padding: 2px 8px; border-radius: 4px; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    table th { text-align: left; padding: 8px 12px; background: #e9ecef; border: 1px solid #ddd; }
    .timestamp { text-align: center; color: #888; font-size: 0.85rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Request Information</h1>
    <div class="card">
      <h2>Request</h2>
      <div class="field"><span class="label">Method</span><span class="value">${escapeHtml(req.method)}</span></div>
      <div class="field"><span class="label">URL</span><span class="value">${escapeHtml(req.url)}</span></div>
      <div class="field"><span class="label">Client IP</span><span class="value">${escapeHtml(String(clientIP))}</span></div>
      <div class="field"><span class="label">HTTP Ver.</span><span class="value">HTTP/${req.httpVersion}</span></div>
    </div>
    <div class="card">
      <h2>Headers</h2>
      <table>
        <tr><th>Name</th><th>Value</th></tr>
        ${headers}
      </table>
    </div>
    <p class="timestamp">Served at ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

server.listen(3456, '0.0.0.0', () => {
  console.log('Server listening on http://0.0.0.0:3456');
});
