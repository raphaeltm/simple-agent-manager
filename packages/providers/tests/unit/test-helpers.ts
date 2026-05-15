import { expect } from 'vitest';

type MockWithCalls = { mock: { calls: unknown[][] } };

function expectRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf('object');
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected JSON body to be an object');
  }
  return value;
}

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
  return expectRecord(JSON.parse(init.body));
}

export function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  if (value === null || value === undefined) throw new Error('Expected value to be defined');
  return value;
}

export function testIpv4(a: number, b: number, c: number, d: number): string {
  return `${a}.${b}.${c}.${d}`;
}

export function testCidr(a: number, b: number, c: number, d: number, prefix: number): string {
  return `${testIpv4(a, b, c, d)}/${prefix}`;
}
