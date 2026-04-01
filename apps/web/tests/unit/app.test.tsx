import { describe, expect,it } from 'vitest';

describe('App', () => {
  it('has the expected environment setup', () => {
    expect(typeof window).toBe('object');
  });
});
