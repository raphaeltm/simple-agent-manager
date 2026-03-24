import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Landing page source contract', () => {
  const file = readFileSync(resolve(__dirname, '../../../src/pages/Landing.tsx'), 'utf8');

  it('does not advertise idle-based zero-cost behavior', () => {
    expect(file).not.toContain('Zero Cost');
    expect(file).not.toContain('When idle');
  });

  it('includes BYOC messaging', () => {
    expect(file).toContain('Bring your own cloud');
    expect(file).toContain('your infrastructure, your costs');
  });

  it('does not contain marketing sections', () => {
    expect(file).not.toContain('How It Works');
    expect(file).not.toContain('Choose Your Agent');
    expect(file).not.toContain('Platform Features');
    expect(file).not.toContain('Shipped & Planned');
  });
});
