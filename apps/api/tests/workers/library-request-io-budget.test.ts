/** Count foreground combined-app I/O, including auth, settings, directory, tags and R2. */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import worker from '../../src/index';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const project = `library-io-${crypto.randomUUID()}`;
let cookie = '';

beforeAll(async () => {
  const user = `library-io-user-${crypto.randomUUID()}`;
  const installation = `library-io-inst-${crypto.randomUUID()}`;
  await seedUser(user);
  await seedInstallation(installation, user);
  await seedProject(project, user, installation);
  cookie = await seedSignedInUser(user);
});

it('bounds full-metadata upload/replacement to twelve D1 plus one R2 operation', async () => {
  let calls = 0;
  const queries: string[] = [];
  const statement = (inner: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(inner, {
      get(target, property) {
        if (property === 'bind')
          return (...values: unknown[]) => statement(target.bind(...values), sql);
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (['all', 'run', 'first', 'raw'].includes(String(property))) {
          return (...args: unknown[]) => {
            calls++;
            queries.push(sql);
            return Reflect.apply(value, target, args);
          };
        }
        return value.bind(target);
      },
    });
  const database = <T extends D1Database | D1DatabaseSession>(inner: T): T =>
    new Proxy(inner, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => statement(target.prepare(sql), sql);
        if (property === 'withSession' && 'withSession' in target)
          return (anchor?: string) => database(target.withSession(anchor));
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property === 'batch' || property === 'exec')
          return (...args: unknown[]) => {
            calls++;
            return Reflect.apply(value, target, args);
          };
        return value.bind(target);
      },
    });
  let r2Calls = 0;
  const r2 = new Proxy(env.R2, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        r2Calls++;
        return Reflect.apply(value, target, args);
      };
    },
  });
  const bindings = { ...env, DATABASE: database(env.DATABASE), R2: r2 } as unknown as Env;
  const totals: number[] = [];
  let id = '';
  for (const mode of ['cold-upload', 'warm-upload', 'replace']) {
    calls = 0;
    queries.length = 0;
    r2Calls = 0;
    const form = new FormData();
    form.append('file', new File(['budget'], `${mode}.txt`, { type: 'text/plain' }));
    form.append('directory', '/budget');
    form.append('tags', 'io-budget');
    const request = new Request(
      `https://api.test.example.com/api/projects/${project}/library/${mode === 'replace' ? `${id}/replace` : 'upload'}`,
      {
        method: mode === 'replace' ? 'PUT' : 'POST',
        headers: { Cookie: cookie, Origin: 'https://app.test.example.com' },
        body: form,
      }
    );
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, bindings, ctx);
    expect(response.status, await response.clone().text()).toBe(mode === 'replace' ? 200 : 201);
    const result = await response.json<{ id: string }>();
    id = result.id;
    totals.push(calls + r2Calls);
    expect(r2Calls).toBe(1);
    expect(calls + r2Calls).toBeLessThanOrEqual(13);
    expect(calls, `${mode}: ${queries.join('\n')}`).toBeLessThanOrEqual(12);
    console.info('library.request_io_case', {
      mode,
      calls,
      settingsSnapshotReads: queries.filter((sql) => /FROM platform_settings\s*$/i.test(sql))
        .length,
    });
    expect(queries.filter((sql) => /FROM platform_settings\s*$/i.test(sql)).length).toBe(
      mode === 'cold-upload' ? 1 : 0
    );
    await waitOnExecutionContext(ctx);
  }
  expect(totals).toMatchInlineSnapshot(`
    [
      13,
      10,
      8,
    ]
  `);
  console.info('library.request_io_budget', {
    coldUpload: totals[0],
    warmUpload: totals[1],
    replace: totals[2],
  });
});
