/**
 * Integration tests for the AdminLogs Durable Object.
 *
 * Runs inside the workerd runtime via @cloudflare/vitest-pool-workers,
 * exercising real DO lifecycle and WebSocket handling.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

function getStub() {
  const id = env.ADMIN_LOGS.idFromName('admin-logs');
  return env.ADMIN_LOGS.get(id);
}

describe('AdminLogs Durable Object', () => {
  describe('fetch routing', () => {
    it('returns 404 for unknown paths', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/unknown');
      expect(response.status).toBe(404);
    });

    it('returns 426 for /ws without WebSocket upgrade header', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ws');
      expect(response.status).toBe(426);
    });
  });

  describe('log ingestion via /ingest', () => {
    it('accepts valid log batch', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'error',
                event: 'test.error',
                message: 'Test error message',
                details: { foo: 'bar' },
                scriptName: 'test-worker',
              },
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
    });

    it('handles empty logs array', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs: [] }),
      });
      expect(response.status).toBe(200);
    });

    it('handles invalid JSON body', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(response.status).toBe(400);
    });

    it('handles missing logs field', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
    });

    it('accepts multiple log entries in a batch', async () => {
      const stub = getStub();
      const logs = Array.from({ length: 5 }, (_, i) => ({
        type: 'log',
        entry: {
          timestamp: new Date().toISOString(),
          level: i % 2 === 0 ? 'error' : 'info',
          event: `test.event.${i}`,
          message: `Test message ${i}`,
          details: {},
          scriptName: 'test-worker',
        },
      }));

      const response = await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logs }),
      });
      expect(response.status).toBe(200);
    });
  });

  describe('WebSocket upgrade via /ws', () => {
    it('upgrades to WebSocket with proper headers', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });

      // In workerd runtime, this returns a 101 with webSocket property
      expect(response.status).toBe(101);
      expect(response.webSocket).toBeDefined();
    });

    it('receives status message on connect', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const ws = response.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(event.data as string);
      });

      // Give the DO time to send the status message
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The first message should be a status message
      expect(messages.length).toBeGreaterThanOrEqual(1);
      const status = JSON.parse(messages[0]);
      expect(status.type).toBe('status');
      expect(status.connected).toBe(true);
      expect(typeof status.clientCount).toBe('number');

      ws.close();
    });

    it('handles ping/pong', async () => {
      const stub = getStub();
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });

      const ws = response.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(event.data as string);
      });

      // Wait for initial status message
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send ping
      ws.send(JSON.stringify({ type: 'ping' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received pong
      const pongMessage = messages.find((m) => {
        const parsed = JSON.parse(m);
        return parsed.type === 'pong';
      });
      expect(pongMessage).toBeDefined();

      ws.close();
    });
  });

  describe('broadcast and filtering', () => {
    it('broadcasts ingested logs to connected WebSocket clients', async () => {
      const stub = getStub();

      // Connect a WebSocket client
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });
      const ws = response.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(event.data as string);
      });

      // Wait for connection status
      await new Promise((resolve) => setTimeout(resolve, 50));
      const initialCount = messages.length;

      // Ingest a log entry
      await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'error',
                event: 'broadcast.test',
                message: 'Broadcast test message',
                details: {},
                scriptName: 'test-worker',
              },
            },
          ],
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received the broadcast
      expect(messages.length).toBeGreaterThan(initialCount);

      const logMessage = messages.slice(initialCount).find((m) => {
        const parsed = JSON.parse(m);
        return parsed.type === 'log' && parsed.entry?.event === 'broadcast.test';
      });
      expect(logMessage).toBeDefined();

      ws.close();
    });

    it('filters logs by level when client sets filter', async () => {
      const stub = getStub();

      // Connect
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });
      const ws = response.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(event.data as string);
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Set filter to only receive errors
      ws.send(JSON.stringify({ type: 'filter', levels: ['error'] }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const countBefore = messages.length;

      // Ingest both error and info logs
      await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'error',
                event: 'filter.test.error',
                message: 'Error message',
                details: {},
                scriptName: 'test-worker',
              },
            },
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'info',
                event: 'filter.test.info',
                message: 'Info message',
                details: {},
                scriptName: 'test-worker',
              },
            },
          ],
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      const newMessages = messages.slice(countBefore);
      const logMessages = newMessages
        .map((m) => JSON.parse(m))
        .filter((m: { type: string }) => m.type === 'log');

      // Should only have the error, not the info
      expect(logMessages.length).toBe(1);
      expect(logMessages[0].entry.level).toBe('error');

      ws.close();
    });

    it('pauses and resumes log delivery', async () => {
      const stub = getStub();

      // Connect
      const response = await stub.fetch('https://internal/ws', {
        headers: { Upgrade: 'websocket' },
      });
      const ws = response.webSocket!;
      ws.accept();

      const messages: string[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(event.data as string);
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Pause
      ws.send(JSON.stringify({ type: 'pause' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const countAfterPause = messages.length;

      // Ingest while paused
      await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'error',
                event: 'pause.test',
                message: 'Should not be received while paused',
                details: {},
                scriptName: 'test-worker',
              },
            },
          ],
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should NOT have received the log while paused
      expect(messages.length).toBe(countAfterPause);

      // Resume
      ws.send(JSON.stringify({ type: 'resume' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const countAfterResume = messages.length;

      // Ingest after resume
      await stub.fetch('https://internal/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          logs: [
            {
              type: 'log',
              entry: {
                timestamp: new Date().toISOString(),
                level: 'error',
                event: 'resume.test',
                message: 'Should be received after resume',
                details: {},
                scriptName: 'test-worker',
              },
            },
          ],
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have received the log after resume
      expect(messages.length).toBeGreaterThan(countAfterResume);

      ws.close();
    });
  });
});
