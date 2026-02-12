import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Landing page source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/pages/Landing.tsx'), 'utf8');

  it('does not advertise idle-based zero-cost behavior', () => {
    expect(file).not.toContain('Zero Cost');
    expect(file).not.toContain('When idle');
    expect(file).toContain('Pay as you go');
    expect(file).toContain('Stop when done');
  });
});
