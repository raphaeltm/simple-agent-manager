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
    expect(file).toContain('Pay As You Go');
    expect(file).toContain('Your cloud, your costs');
  });
});
