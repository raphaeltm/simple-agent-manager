import { describe, it, expect } from 'vitest';

describe('App', () => {
  it('has the expected environment setup', () => {
    expect(typeof window).toBe('object');
  });
});
