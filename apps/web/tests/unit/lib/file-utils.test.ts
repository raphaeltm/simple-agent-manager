import { describe, expect, it } from 'vitest';

import {
  baseMimeType,
  FILE_PREVIEW_INLINE_MAX_BYTES,
  FILE_PREVIEW_LOAD_MAX_BYTES,
  formatFileSize,
  isHtmlMime,
  isImageFile,
  isMarkdownMime,
  isPdfMime,
  isPreviewableImageMime,
  isPreviewableMime,
  isSvgFile,
} from '../../../src/lib/file-utils';

describe('isImageFile', () => {
  it('returns true for common image extensions', () => {
    expect(isImageFile('photo.png')).toBe(true);
    expect(isImageFile('photo.jpg')).toBe(true);
    expect(isImageFile('photo.jpeg')).toBe(true);
    expect(isImageFile('animation.gif')).toBe(true);
    expect(isImageFile('icon.svg')).toBe(true);
    expect(isImageFile('modern.webp')).toBe(true);
    expect(isImageFile('new.avif')).toBe(true);
    expect(isImageFile('favicon.ico')).toBe(true);
    expect(isImageFile('legacy.bmp')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isImageFile('PHOTO.PNG')).toBe(true);
    expect(isImageFile('Photo.JPG')).toBe(true);
    expect(isImageFile('icon.SVG')).toBe(true);
  });

  it('returns false for non-image files', () => {
    expect(isImageFile('script.ts')).toBe(false);
    expect(isImageFile('readme.md')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
    expect(isImageFile('style.css')).toBe(false);
    expect(isImageFile('Makefile')).toBe(false);
    expect(isImageFile('binary.exe')).toBe(false);
  });

  it('handles paths with directories', () => {
    expect(isImageFile('src/assets/logo.png')).toBe(true);
    expect(isImageFile('docs/images/diagram.svg')).toBe(true);
    expect(isImageFile('path/to/file.ts')).toBe(false);
  });

  it('handles edge cases', () => {
    expect(isImageFile('')).toBe(false);
    expect(isImageFile('noextension')).toBe(false);
    expect(isImageFile('.png')).toBe(true); // hidden file with png extension
  });
});

describe('isSvgFile', () => {
  it('returns true for SVG files', () => {
    expect(isSvgFile('icon.svg')).toBe(true);
    expect(isSvgFile('path/to/diagram.SVG')).toBe(true);
  });

  it('returns false for non-SVG files', () => {
    expect(isSvgFile('photo.png')).toBe(false);
    expect(isSvgFile('file.svgz')).toBe(false);
  });
});

describe('formatFileSize', () => {
  it('formats bytes correctly', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(10240)).toBe('10 KB');
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(5242880)).toBe('5.0 MB');
    expect(formatFileSize(1073741824)).toBe('1.0 GB');
  });
});

describe('isPreviewableMime', () => {
  it('returns true for previewable image MIME types', () => {
    expect(isPreviewableMime('image/png')).toBe(true);
    expect(isPreviewableMime('image/jpeg')).toBe(true);
    expect(isPreviewableMime('image/gif')).toBe(true);
    expect(isPreviewableMime('image/webp')).toBe(true);
    expect(isPreviewableMime('image/avif')).toBe(true);
  });

  it('returns true for PDF', () => {
    expect(isPreviewableMime('application/pdf')).toBe(true);
  });

  it('returns true for markdown', () => {
    expect(isPreviewableMime('text/markdown')).toBe(true);
  });

  it('returns true for HTML', () => {
    expect(isPreviewableMime('text/html')).toBe(true);
    expect(isPreviewableMime('Text/HTML; charset=utf-8')).toBe(true);
  });

  it('handles MIME types with charset parameters', () => {
    expect(isPreviewableMime('text/markdown; charset=utf-8')).toBe(true);
    expect(isPreviewableMime('image/png; charset=utf-8')).toBe(true);
    expect(isPreviewableMime('application/pdf; charset=binary')).toBe(true);
    expect(isPreviewableMime('text/plain; charset=utf-8')).toBe(false);
  });

  it('returns false for SVG (script risk in iframe)', () => {
    expect(isPreviewableMime('image/svg+xml')).toBe(false);
  });

  it('returns false for non-previewable types', () => {
    expect(isPreviewableMime('text/plain')).toBe(false);
    expect(isPreviewableMime('application/json')).toBe(false);
    expect(isPreviewableMime('application/javascript')).toBe(false);
    expect(isPreviewableMime('application/zip')).toBe(false);
    expect(isPreviewableMime('image/bmp')).toBe(false);
    expect(isPreviewableMime('image/x-icon')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isPreviewableMime('IMAGE/PNG')).toBe(true);
    expect(isPreviewableMime('Application/PDF')).toBe(true);
  });

  it('recovers previewability from the filename when the stored type is octet-stream', () => {
    // The agent-upload bug: files land as application/octet-stream. With a
    // filename, the effective type is recovered from the extension.
    expect(isPreviewableMime('application/octet-stream', 'notes.md')).toBe(true);
    expect(isPreviewableMime('application/octet-stream', 'page.html')).toBe(true);
    expect(isPreviewableMime('application/octet-stream', 'diagram.png')).toBe(true);
    expect(isPreviewableMime('', 'notes.md')).toBe(true);
  });

  it('does not preview octet-stream files with no known extension', () => {
    expect(isPreviewableMime('application/octet-stream', 'blob.bin')).toBe(false);
    expect(isPreviewableMime('application/octet-stream', 'Makefile')).toBe(false);
    expect(isPreviewableMime('application/octet-stream')).toBe(false);
    // Non-previewable text extensions stay non-previewable even via the filename.
    expect(isPreviewableMime('application/octet-stream', 'log.txt')).toBe(false);
    // SVG resolves from the extension but remains non-previewable (iframe script risk).
    expect(isPreviewableMime('application/octet-stream', 'icon.svg')).toBe(false);
  });

  it('never lets the filename override a meaningful stored type', () => {
    // A file explicitly stored as text/plain stays non-previewable even if the
    // name looks like markdown.
    expect(isPreviewableMime('text/plain', 'actually.md')).toBe(false);
  });
});

describe('isPreviewableImageMime', () => {
  it('returns true for image types only', () => {
    expect(isPreviewableImageMime('image/png')).toBe(true);
    expect(isPreviewableImageMime('image/jpeg')).toBe(true);
  });

  it('returns false for PDF', () => {
    expect(isPreviewableImageMime('application/pdf')).toBe(false);
  });

  it('returns false for SVG', () => {
    expect(isPreviewableImageMime('image/svg+xml')).toBe(false);
  });
});

describe('isPdfMime', () => {
  it('returns true for PDF', () => {
    expect(isPdfMime('application/pdf')).toBe(true);
    expect(isPdfMime('Application/PDF')).toBe(true);
  });

  it('returns false for non-PDF', () => {
    expect(isPdfMime('image/png')).toBe(false);
    expect(isPdfMime('text/plain')).toBe(false);
  });
});

describe('isMarkdownMime', () => {
  it('returns true for markdown', () => {
    expect(isMarkdownMime('text/markdown')).toBe(true);
    expect(isMarkdownMime('Text/Markdown')).toBe(true);
  });

  it('returns true for markdown with charset parameter', () => {
    expect(isMarkdownMime('text/markdown; charset=utf-8')).toBe(true);
    expect(isMarkdownMime('Text/Markdown; charset=UTF-8')).toBe(true);
  });

  it('returns false for non-markdown', () => {
    expect(isMarkdownMime('text/plain')).toBe(false);
    expect(isMarkdownMime('text/html')).toBe(false);
    expect(isMarkdownMime('application/pdf')).toBe(false);
    expect(isMarkdownMime('image/png')).toBe(false);
  });

  it('recovers markdown from the filename for octet-stream/empty stored types', () => {
    expect(isMarkdownMime('application/octet-stream', 'foo.md')).toBe(true);
    expect(isMarkdownMime('application/octet-stream', 'foo.markdown')).toBe(true);
    expect(isMarkdownMime('', 'foo.md')).toBe(true);
    // No filename, or a non-markdown extension → not markdown.
    expect(isMarkdownMime('application/octet-stream')).toBe(false);
    expect(isMarkdownMime('application/octet-stream', 'foo.bin')).toBe(false);
    // A real binary with a markdown-looking name is NOT treated as markdown.
    expect(isMarkdownMime('image/png', 'foo.md')).toBe(false);
  });
});

describe('isHtmlMime', () => {
  it('returns true for HTML', () => {
    expect(isHtmlMime('text/html')).toBe(true);
    expect(isHtmlMime('Text/HTML')).toBe(true);
  });

  it('returns true for HTML with charset parameter', () => {
    expect(isHtmlMime('text/html; charset=utf-8')).toBe(true);
    expect(isHtmlMime('Text/HTML; charset=UTF-8')).toBe(true);
  });

  it('returns false for non-HTML', () => {
    expect(isHtmlMime('text/plain')).toBe(false);
    expect(isHtmlMime('text/markdown')).toBe(false);
    expect(isHtmlMime('application/pdf')).toBe(false);
    expect(isHtmlMime('image/png')).toBe(false);
  });

  it('recovers HTML from the filename for octet-stream/empty stored types', () => {
    expect(isHtmlMime('application/octet-stream', 'page.html')).toBe(true);
    expect(isHtmlMime('application/octet-stream', 'page.htm')).toBe(true);
    expect(isHtmlMime('', 'page.html')).toBe(true);
    expect(isHtmlMime('application/octet-stream', 'notes.md')).toBe(false);
  });
});

describe('baseMimeType', () => {
  it('strips charset parameters', () => {
    expect(baseMimeType('text/markdown; charset=utf-8')).toBe('text/markdown');
    expect(baseMimeType('image/png; charset=utf-8')).toBe('image/png');
  });

  it('lowercases the result', () => {
    expect(baseMimeType('Text/Markdown')).toBe('text/markdown');
    expect(baseMimeType('APPLICATION/PDF')).toBe('application/pdf');
  });

  it('handles bare MIME types without parameters', () => {
    expect(baseMimeType('text/plain')).toBe('text/plain');
    expect(baseMimeType('image/png')).toBe('image/png');
  });

  it('handles multiple parameters', () => {
    expect(baseMimeType('text/markdown; charset=utf-8; boundary=something')).toBe('text/markdown');
  });
});

describe('threshold constants', () => {
  it('has correct default values', () => {
    expect(FILE_PREVIEW_INLINE_MAX_BYTES).toBe(10 * 1024 * 1024); // 10 MB
    expect(FILE_PREVIEW_LOAD_MAX_BYTES).toBe(50 * 1024 * 1024); // 50 MB
  });

  it('inline threshold is less than load threshold', () => {
    expect(FILE_PREVIEW_INLINE_MAX_BYTES).toBeLessThan(FILE_PREVIEW_LOAD_MAX_BYTES);
  });
});
