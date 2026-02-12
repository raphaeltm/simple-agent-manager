import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('cors config source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('allows idempotency key request header for cross-origin session creation', () => {
    expect(file).toContain("allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']");
  });
});
