import { expect } from 'vitest';

type MockWithCalls = { mock: { calls: unknown[][] } };

export function fetchCall(mockFetch: MockWithCalls, index: number): { url: string; init: RequestInit } {
  const call = mockFetch.mock.calls.at(index);
  expect(call).toBeDefined();
  if (!call) throw new Error(`Expected fetch call at index ${index}`);

  const [url, init] = call;
  return {
    url: String(url),
    init: (init ?? {}) as RequestInit,
  };
}

export function jsonBody(init: RequestInit): Record<string, unknown> {
  expect(typeof init.body).toBe('string');
  if (typeof init.body !== 'string') throw new Error('Expected request body to be a string');
  return JSON.parse(init.body) as Record<string, unknown>;
}

export function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === null || value === undefined) throw new Error('Expected value to be defined');
  return value;
}
