/**
 * Tests for Valibot validation middleware integration.
 *
 * Verifies:
 * - jsonValidator returns 400 (not 500) for malformed JSON
 * - jsonValidator returns 400 with correct error format for schema violations
 * - Discriminated union schemas work correctly (CreateCredentialSchema)
 * - parseOptionalBody falls back gracefully on invalid/missing body
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import * as v from 'valibot';
import { jsonValidator, parseOptionalBody } from '../../../src/schemas/_validator';

// ---------------------------------------------------------------------------
// jsonValidator: malformed JSON → 400
// ---------------------------------------------------------------------------

describe('jsonValidator', () => {
  const TestSchema = v.object({
    name: v.string(),
    age: v.optional(v.number()),
  });

  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.onError((err, c) => {
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.post('/test', jsonValidator(TestSchema), (c) => {
      const body = c.req.valid('json');
      return c.json({ ok: true, body });
    });
  });

  it('returns 400 with BAD_REQUEST for malformed JSON', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 with BAD_REQUEST for empty body', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('returns 400 with field-level error for schema violations', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 123 }), // name should be string
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('name');
  });

  it('returns 400 when required field is missing', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ age: 25 }), // missing required name
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('BAD_REQUEST');
    expect(body.message).toContain('name');
  });

  it('passes valid input through to handler', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', age: 30 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.body.name).toBe('Alice');
    expect(body.body.age).toBe(30);
  });

  it('strips unknown fields from valid input', async () => {
    const res = await app.request('/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', extra: 'field' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.body.name).toBe('Alice');
    expect(body.body.extra).toBeUndefined();
  });

  it('does not catch non-JSON errors', async () => {
    const ErrorSchema = v.object({ x: v.string() });
    const errorApp = new Hono();
    errorApp.onError((err, c) => {
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    errorApp.post('/err', jsonValidator(ErrorSchema), () => {
      throw new Error('route logic error');
    });

    const res = await errorApp.request('/err', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 'valid' }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// parseOptionalBody: graceful fallback
// ---------------------------------------------------------------------------

describe('parseOptionalBody', () => {
  const OptionalSchema = v.object({
    mode: v.optional(v.picklist(['full', 'summary'])),
  });

  const fallback = {};

  it('returns fallback for empty body', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
    });
    const result = await parseOptionalBody(req, OptionalSchema, fallback);
    expect(result).toEqual(fallback);
  });

  it('returns fallback for invalid JSON', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const result = await parseOptionalBody(req, OptionalSchema, fallback);
    expect(result).toEqual(fallback);
  });

  it('returns fallback for JSON that fails schema validation', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'invalid-mode' }),
    });
    const result = await parseOptionalBody(req, OptionalSchema, fallback);
    expect(result).toEqual(fallback);
  });

  it('returns parsed body for valid JSON', async () => {
    const req = new Request('http://localhost/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full' }),
    });
    const result = await parseOptionalBody(req, OptionalSchema, fallback);
    expect(result).toEqual({ mode: 'full' });
  });
});

// ---------------------------------------------------------------------------
// Schema correctness: discriminated union (CreateCredentialSchema)
// ---------------------------------------------------------------------------

describe('CreateCredentialSchema', () => {
  // Import the schema directly for unit testing
  let CreateCredentialSchema: v.GenericSchema;

  beforeEach(async () => {
    const mod = await import('../../../src/schemas/credentials');
    CreateCredentialSchema = mod.CreateCredentialSchema;
  });

  it('accepts valid hetzner credential', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      provider: 'hetzner',
      token: 'test-hetzner-token',
      label: 'My Hetzner',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid scaleway credential', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      provider: 'scaleway',
      secretKey: 'secret-key-value',
      projectId: 'proj-456',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown provider', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      provider: 'aws',
      token: 'test-token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects hetzner credential missing token', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      provider: 'hetzner',
      label: 'My Hetzner',
    });
    expect(result.success).toBe(false);
  });

  it('rejects scaleway credential missing required fields', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      provider: 'scaleway',
      secretKey: 'secret-key-value',
      // missing projectId
    });
    expect(result.success).toBe(false);
  });

  it('rejects payload with no provider field', () => {
    const result = v.safeParse(CreateCredentialSchema, {
      token: 'test-token',
    });
    expect(result.success).toBe(false);
  });
});
