import { describe, expect, it } from 'vitest';

import {
  baseMimeType,
  isUnknownMimeType,
  mimeTypeFromFilename,
  resolveEffectiveMimeType,
} from '../../src/types/library';

describe('baseMimeType', () => {
  it('strips parameters and lowercases', () => {
    expect(baseMimeType('text/Markdown; charset=utf-8')).toBe('text/markdown');
    expect(baseMimeType('  APPLICATION/JSON ')).toBe('application/json');
  });
});

describe('isUnknownMimeType', () => {
  it('treats octet-stream and empty as unknown', () => {
    expect(isUnknownMimeType('application/octet-stream')).toBe(true);
    expect(isUnknownMimeType('APPLICATION/OCTET-STREAM')).toBe(true);
    expect(isUnknownMimeType('')).toBe(true);
    expect(isUnknownMimeType(null)).toBe(true);
    expect(isUnknownMimeType(undefined)).toBe(true);
  });

  it('treats real types as known', () => {
    expect(isUnknownMimeType('text/markdown')).toBe(false);
    expect(isUnknownMimeType('image/png')).toBe(false);
    expect(isUnknownMimeType('text/html; charset=utf-8')).toBe(false);
  });
});

describe('mimeTypeFromFilename', () => {
  it('maps curated text/document extensions', () => {
    expect(mimeTypeFromFilename('README.md')).toBe('text/markdown');
    expect(mimeTypeFromFilename('notes.markdown')).toBe('text/markdown');
    expect(mimeTypeFromFilename('log.txt')).toBe('text/plain');
    expect(mimeTypeFromFilename('config.yaml')).toBe('application/yaml');
    expect(mimeTypeFromFilename('Cargo.toml')).toBe('application/toml');
    expect(mimeTypeFromFilename('data.csv')).toBe('text/csv');
    expect(mimeTypeFromFilename('pkg.json')).toBe('application/json');
    expect(mimeTypeFromFilename('pom.xml')).toBe('application/xml');
  });

  it('maps html/pdf/image extensions', () => {
    expect(mimeTypeFromFilename('page.html')).toBe('text/html');
    expect(mimeTypeFromFilename('page.htm')).toBe('text/html');
    expect(mimeTypeFromFilename('report.pdf')).toBe('application/pdf');
    expect(mimeTypeFromFilename('photo.PNG')).toBe('image/png');
    expect(mimeTypeFromFilename('icon.svg')).toBe('image/svg+xml');
  });

  it('is case-insensitive', () => {
    expect(mimeTypeFromFilename('README.MD')).toBe('text/markdown');
    expect(mimeTypeFromFilename('CONFIG.YAML')).toBe('application/yaml');
  });

  it('returns empty for unknown / missing extensions', () => {
    expect(mimeTypeFromFilename('binary.unknownext')).toBe('');
    expect(mimeTypeFromFilename('Makefile')).toBe('');
    expect(mimeTypeFromFilename('.env')).toBe('');
    expect(mimeTypeFromFilename('')).toBe('');
    expect(mimeTypeFromFilename(null)).toBe('');
    expect(mimeTypeFromFilename(undefined)).toBe('');
  });
});

describe('resolveEffectiveMimeType', () => {
  it('falls back to the filename extension when the stored MIME is octet-stream', () => {
    expect(resolveEffectiveMimeType('application/octet-stream', 'notes.md')).toBe('text/markdown');
    expect(resolveEffectiveMimeType('application/octet-stream', 'page.html')).toBe('text/html');
    expect(resolveEffectiveMimeType('', 'config.yaml')).toBe('application/yaml');
  });

  it('preserves a known stored MIME verbatim (ignoring the extension)', () => {
    // A real image stored as image/png keeps its type even if the name lies.
    expect(resolveEffectiveMimeType('image/png', 'trickery.md')).toBe('image/png');
    expect(resolveEffectiveMimeType('text/markdown; charset=utf-8', 'notes.md')).toBe('text/markdown');
  });

  it('returns the unknown base when neither MIME nor extension resolves', () => {
    expect(resolveEffectiveMimeType('application/octet-stream', 'binary.bin')).toBe('application/octet-stream');
    expect(resolveEffectiveMimeType('application/octet-stream', undefined)).toBe('application/octet-stream');
    expect(resolveEffectiveMimeType('', 'noext')).toBe('');
  });

  it('resolves octet-stream .svg to image/svg+xml (caller must still gate it out of preview)', () => {
    expect(resolveEffectiveMimeType('application/octet-stream', 'icon.svg')).toBe('image/svg+xml');
  });
});
