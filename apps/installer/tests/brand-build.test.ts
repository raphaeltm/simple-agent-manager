import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { installerShell, maintenanceBrand } from '../src/maintenance-brand.generated';

describe('standalone brand build', () => {
  it('keeps hosted handoff styles and scripts compatible with self-only CSP', () => {
    const shell = installerShell.before + installerShell.after;
    expect(shell).toContain('rel="stylesheet"');
    expect(shell).not.toContain('<style>');
    expect(shell).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  });
  it('embeds maintenance assets and authorizes only its compiled scripts', () => {
    const shell = maintenanceBrand.before + maintenanceBrand.after;
    expect(shell).toContain('data:font/woff2;base64,');
    expect(shell).not.toMatch(/(?:src|href)="\/(?:_astro|fonts)/);
    expect(shell).not.toMatch(/url\(['"]?\/fonts\//);
    const scripts = [...shell.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(maintenanceBrand.scriptHashes).toContain(
        "'sha256-" + createHash('sha256').update(script[1]!).digest('base64') + "'"
      );
      expect(script[1]).not.toMatch(/\bimport\s.*?from\s*['"]\//);
    }
  });
  it('serves installer assets locally without a marketing runtime dependency', () => {
    const html = readFileSync(new URL('../site-static/index.html', import.meta.url), 'utf8');
    expect(html).toContain('class="theme-toggle"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain('Prototype</span>');
    expect(html).not.toContain('installation-plane');
    expect(html).not.toMatch(
      /<(?:script|link)[^>]+(?:src|href)="https:\/\/(?:www\.)?(?:simple-agent-manager\.org|sammy\.party)/
    );
  });
});
