import { describe, expect, it } from 'vitest';

import { buildSandboxedHtmlSrcDoc } from '../../../src/components/shared-file-viewer/HtmlViewer';

describe('buildSandboxedHtmlSrcDoc', () => {
  it('injects a restrictive CSP before document scripts', () => {
    const html = '<!doctype html><html><head><title>Report</title></head><body><script>window.ready = true;</script></body></html>';

    const srcDoc = buildSandboxedHtmlSrcDoc(html);

    expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain("script-src 'unsafe-inline'");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("object-src 'none'");
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('<script>'));
  });

  it('adds a head element when the HTML document has none', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc('<html><body><h1>Report</h1></body></html>');

    expect(srcDoc).toContain('<html><head><meta http-equiv="Content-Security-Policy"');
    expect(srcDoc).toContain('<body><h1>Report</h1></body>');
  });

  it('supports HTML fragments by prefixing the CSP metadata', () => {
    const srcDoc = buildSandboxedHtmlSrcDoc('<section>Inline report</section>');

    expect(srcDoc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(srcDoc).toContain('<section>Inline report</section>');
  });
});
