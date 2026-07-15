import { describe, expect, it } from 'vitest';

import { buildSandboxedHtmlSrcDoc } from '../../../src/components/shared-file-viewer/HtmlViewer';

describe('buildSandboxedHtmlSrcDoc', () => {
  it('injects a restrictive CSP before document scripts', () => {
    const html = '<!doctype html><html><head><title>Report</title></head><body><script>window.ready = true;</script></body></html>';

    const srcDoc = buildSandboxedHtmlSrcDoc(html);

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("object-src 'none'");
    expect(srcDoc).not.toContain('<script>');
    expect(srcDoc).not.toContain('window.ready');
  });

  it('adds a head element when the HTML document has none', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc('<html><body><h1>Report</h1></body></html>');

    expect(srcDoc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(srcDoc).toContain('<h1>Report</h1>');
  });

  it('supports HTML fragments by prefixing the CSP metadata', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc('<section>Inline report</section>');

    expect(srcDoc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(srcDoc).toContain('<section>Inline report</section>');
  });


  it('preserves benign document content while stripping executable and navigation surfaces', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc(`<!doctype html>
      <html>
        <head><title>Report</title><meta name="ignored" content="x"></head>
        <body>
          <h1 onclick="alert(1)">Quarterly Report</h1>
          <p style="color: red">Allowed text formatting</p>
          <img src="data:image/png;base64,abc" alt="Chart">
          <a href="https://evil.example/path" target="_blank" ping="https://evil.example/ping">External link text</a>
          <form action="https://evil.example/submit"><input name="token" value="secret"></form>
          <iframe src="https://evil.example/frame"></iframe>
          <object data="https://evil.example/object"></object>
          <script>alert('xss')</script>
        </body>
      </html>`);

    expect(srcDoc).toContain('Quarterly Report');
    expect(srcDoc).toContain('Allowed text formatting');
    expect(srcDoc).toContain('data:image/png;base64,abc');
    expect(srcDoc).toContain('External link text');
    expect(srcDoc).not.toMatch(/onclick|<script|alert\(|<form|<input|<iframe|<object|evil\.example|href=|target=|ping=/i);
  });

  it('strips javascript URLs and event handlers from fragments', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc('<section><a href="javascript:alert(1)" onmouseover="alert(2)">Click</a><img src="x" onerror="alert(3)"></section>');

    expect(srcDoc).toContain('<section>');
    expect(srcDoc).toContain('Click');
    expect(srcDoc).not.toMatch(/javascript:|onmouseover|onerror|alert\(/i);
  });
});
