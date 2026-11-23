/** Real upgrades and persisted-message broadcasts; only the external D1 lookup is held. */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as projectData from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
const testEnv = env as unknown as Env;

describe('project socket admission ordering', () => {
  it('closes an upgrade without project identity with retryable1013', async () => {
    const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(crypto.randomUUID()));
    const response = await stub.fetch('https://project-data/ws', {
      headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': 'member' },
    });
    expect(response.status).toBe(101);
    const client = response.webSocket!;
    client.accept();
    const close = new Promise<number>((resolve) =>
      client.addEventListener('close', (event) => resolve(event.code))
    );
    expect(await close).toBe(1013);
  });
  it.each(['denied', 'unavailable', 'allowed', 'revoked-during-read'] as const)(
    '%s: withholds transcript until verification, with a live member control',
    async (outcome) => {
      const projectId = crypto.randomUUID(),
        owner = crypto.randomUUID(),
        installation = crypto.randomUUID();
      await seedUser(owner);
      await seedInstallation(installation, owner);
      await seedProject(projectId, owner, installation);
      const sessionId = await projectData.createSession(
        testEnv,
        projectId,
        null,
        'Admission slice',
        null,
        owner
      );
      const stub = testEnv.PROJECT_DATA.get(testEnv.PROJECT_DATA.idFromName(projectId));
      await runInDurableObject(stub, async (instance, state) => {
        const object = instance as unknown as {
          env: { DATABASE: D1Database };
          fetch(request: Request): Promise<Response>;
          persistMessage(sessionId: string, role: string, content: string): Promise<unknown>;
          closeBrowserSocketsForActor(actorId: string): number;
        };
        const original = object.env.DATABASE;
        const open = () =>
          object.fetch(
            new Request(`https://project-data/ws?sessionId=${sessionId}`, {
              headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': owner },
            })
          );
        const controlResponse = await open();
        const control = controlResponse.webSocket!;
        control.accept();
        const seen: string[] = [];
        control.addEventListener('message', (event) => {
          seen.push(String(event.data));
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        let release!: () => void;
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = false;
        object.env.DATABASE = {
          prepare: () => ({
            bind: () => ({
              first: async () => {
                entered = true;
                await barrier;
                if (outcome === 'unavailable') throw new Error('injected admission D1 outage');
                return outcome === 'denied' ? null : { ok: 1 };
              },
            }),
          }),
        } as unknown as D1Database;
        let pending: WebSocket | null = null;
        try {
          let upgradeFinished = false;
          const upgrading = open().then((response) => {
            upgradeFinished = true;
            return response;
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(entered).toBe(true);
          expect(upgradeFinished).toBe(false);
          object.env.DATABASE = original;
          await object.persistMessage(sessionId, 'assistant', 'private-before-proof');
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(seen.some((frame) => frame.includes('private-before-proof'))).toBe(true);
          if (outcome === 'revoked-during-read') object.closeBrowserSocketsForActor(owner);
          release();
          const response = await upgrading;
          expect(response.status).toBe(101);
          pending = response.webSocket!;
          pending.accept();
          const pendingFrames: string[] = [];
          let closeCode: number | null = null;
          pending.addEventListener('message', (event) => {
            pendingFrames.push(String(event.data));
          });
          pending.addEventListener('close', (event) => {
            closeCode = event.code;
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(pendingFrames.some((frame) => frame.includes('private-before-proof'))).toBe(false);
          if (outcome === 'allowed') {
            expect(closeCode).toBeNull();
            // The browser's normal onopen catch-up now runs after verification. Read through
            // the canonical service outside the held upgrade, then prove continued streaming.

            const persisted = state.storage.sql
              .exec('SELECT content FROM chat_messages WHERE session_id = ?', sessionId)
              .toArray();
            expect(persisted.some((row) => row.content === 'private-before-proof')).toBe(true);
            await object.persistMessage(sessionId, 'assistant', 'visible-after-proof');
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(pendingFrames.some((frame) => frame.includes('visible-after-proof'))).toBe(true);
            expect(
              state
                .getWebSockets()
                .some((socket) => socket.deserializeAttachment()?.accessPending === false)
            ).toBe(true);
          } else expect(closeCode).toBe(outcome === 'unavailable' ? 1013 : 4403);
        } finally {
          object.env.DATABASE = original;
          release();
          pending?.close();
          control.close();
        }
      });
      const response = await stub.fetch(`https://project-data/ws?sessionId=${sessionId}`, {
        headers: { Upgrade: 'websocket', 'x-sam-browser-socket-actor': owner },
      });
      expect(response.status).toBe(101);
      const reconnected = response.webSocket!;
      reconnected.accept();
      const frames: string[] = [];
      reconnected.addEventListener('message', (event) => {
        frames.push(String(event.data));
      });
      await projectData.persistMessage(
        testEnv,
        projectId,
        sessionId,
        'assistant',
        'after-reconnect',
        null
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(frames.some((frame) => frame.includes('after-reconnect'))).toBe(true);
      reconnected.close();
    }
  );
});
