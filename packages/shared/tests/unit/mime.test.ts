import { describe, expect, it } from 'vitest';

import {
  isUnknownMimeType,
  mimeTypeFromFilename,
  normalizeMimeType,
  OCTET_STREAM_MIME,
  resolveEffectiveMimeType,
} from '../../src/mime';

describe('normalizeMimeType', () => {
  it('strips parameters, trims, and lowercases', () => {
    expect(normalizeMimeType('Text/Markdown; charset=utf-8')).toBe('text/markdown');
    expect(normalizeMimeType('  IMAGE/PNG  ')).toBe('image/png');
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
  });

  it('returns empty string for empty input', () => {
    expect(normalizeMimeType('')).toBe('');
    expect(normalizeMimeType('   ')).toBe('');
  });
});

describe('isUnknownMimeType', () => {
  it('treats empty and octet-stream as unknown', () => {
    expect(isUnknownMimeType('')).toBe(true);
    expect(isUnknownMimeType('   ')).toBe(true);
    expect(isUnknownMimeType(null)).toBe(true);
    expect(isUnknownMimeType(undefined)).toBe(true);
    expect(isUnknownMimeType('application/octet-stream')).toBe(true);
    expect(isUnknownMimeType('Application/Octet-Stream; charset=binary')).toBe(true);
  });

  it('treats any real type as known', () => {
    expect(isUnknownMimeType('text/markdown')).toBe(false);
    expect(isUnknownMimeType('image/png')).toBe(false);
    expect(isUnknownMimeType('text/plain')).toBe(false);
  });
});

describe('mimeTypeFromFilename', () => {
  it('maps common text/doc extensions', () => {
    expect(mimeTypeFromFilename('README.md')).toBe('text/markdown');
    expect(mimeTypeFromFilename('notes.markdown')).toBe('text/markdown');
    expect(mimeTypeFromFilename('log.txt')).toBe('text/plain');
    expect(mimeTypeFromFilename('app.log')).toBe('text/plain');
    expect(mimeTypeFromFilename('data.csv')).toBe('text/csv');
    expect(mimeTypeFromFilename('config.yaml')).toBe('application/yaml');
    expect(mimeTypeFromFilename('config.yml')).toBe('application/yaml');
    expect(mimeTypeFromFilename('Cargo.toml')).toBe('application/toml');
    expect(mimeTypeFromFilename('package.json')).toBe('application/json');
    expect(mimeTypeFromFilename('data.xml')).toBe('application/xml');
  });

  it('maps previewable doc/image extensions', () => {
    expect(mimeTypeFromFilename('page.html')).toBe('text/html');
    expect(mimeTypeFromFilename('page.htm')).toBe('text/html');
    expect(mimeTypeFromFilename('icon.svg')).toBe('image/svg+xml');
    expect(mimeTypeFromFilename('report.pdf')).toBe('application/pdf');
    expect(mimeTypeFromFilename('logo.png')).toBe('image/png');
    expect(mimeTypeFromFilename('photo.jpg')).toBe('image/jpeg');
    expect(mimeTypeFromFilename('photo.jpeg')).toBe('image/jpeg');
  });

  it('is case-insensitive and handles paths + dotfiles', () => {
    expect(mimeTypeFromFilename('README.MD')).toBe('text/markdown');
    expect(mimeTypeFromFilename('/engineering/byo-nodes/plan.md')).toBe('text/markdown');
    expect(mimeTypeFromFilename('.md')).toBe('text/markdown'); // dotfile treated as extension, matching isImageFile
  });

  it('returns undefined for unknown or missing extensions', () => {
    expect(mimeTypeFromFilename('blob.bin')).toBeUndefined();
    expect(mimeTypeFromFilename('archive.zzz')).toBeUndefined();
    expect(mimeTypeFromFilename('Makefile')).toBeUndefined();
    expect(mimeTypeFromFilename('trailingdot.')).toBeUndefined();
    expect(mimeTypeFromFilename('')).toBeUndefined();
    expect(mimeTypeFromFilename(null)).toBeUndefined();
    expect(mimeTypeFromFilename(undefined)).toBeUndefined();
  });
});

describe('resolveEffectiveMimeType', () => {
  it('trusts a meaningful stored type over the extension', () => {
    // A file explicitly stored as text/plain stays text/plain even if the name
    // suggests markdown — extension sniffing only fills the octet-stream gap.
    expect(resolveEffectiveMimeType('text/plain', 'weird.md')).toBe('text/plain');
    expect(resolveEffectiveMimeType('image/png', 'photo.png')).toBe('image/png');
    expect(resolveEffectiveMimeType('text/markdown; charset=utf-8', 'x.md')).toBe('text/markdown');
  });

  it('falls back to the extension when the stored type is octet-stream (the bug)', () => {
    expect(resolveEffectiveMimeType('application/octet-stream', 'notes.md')).toBe('text/markdown');
    expect(resolveEffectiveMimeType('application/octet-stream', 'index.html')).toBe('text/html');
    expect(resolveEffectiveMimeType('application/octet-stream', 'icon.svg')).toBe('image/svg+xml');
  });

  it('falls back to the extension when the stored type is empty', () => {
    expect(resolveEffectiveMimeType('', 'notes.md')).toBe('text/markdown');
    expect(resolveEffectiveMimeType(null, 'notes.md')).toBe('text/markdown');
    expect(resolveEffectiveMimeType(undefined, 'notes.md')).toBe('text/markdown');
  });

  it('returns octet-stream when neither the stored type nor the extension resolve', () => {
    expect(resolveEffectiveMimeType('application/octet-stream', 'blob.bin')).toBe(OCTET_STREAM_MIME);
    expect(resolveEffectiveMimeType('application/octet-stream', 'Makefile')).toBe(OCTET_STREAM_MIME);
    expect(resolveEffectiveMimeType('application/octet-stream', undefined)).toBe(OCTET_STREAM_MIME);
    expect(resolveEffectiveMimeType('', undefined)).toBe(OCTET_STREAM_MIME);
  });
});
