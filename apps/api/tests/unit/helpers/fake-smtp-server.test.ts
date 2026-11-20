/**
 * The fake SMTP server's `silent` mode backs the deadline tests in smtp-client.test.ts,
 * smtp-client-workerd.test.ts and email-sign-in-smtp.test.ts. Those tests only mean what they
 * say if a silent server never writes a byte, whatever the client sends. A TLS ClientHello
 * carries random bytes that sometimes contain "\r\n"; if the server parsed that as a command
 * line and answered "502", the client's TLS layer failed with "wrong version number" instead
 * of hitting the deadline (main CI run 44705439318).
 */
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { type FakeSmtpServer, startFakeSmtpServer } from '../../helpers/fake-smtp-server';

/** How long to listen for a reply after writing; a loopback reply arrives in well under this. */
const SETTLE_MS = 300;

// Bytes shaped like the start of a TLS ClientHello (record type 0x16, version 0x0301) with a
// CRLF in the middle, followed by a complete SMTP command line. Either part used to draw a reply.
const CLIENT_BYTES = Buffer.concat([
  Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a, 0x01, 0x00, 0x00, 0x26, 0x03, 0x03]),
  Buffer.from('random\r\nbytes'),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a]),
  Buffer.from('EHLO client.example.com\r\nQUIT\r\n'),
]);

let server: FakeSmtpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Connect, write `CLIENT_BYTES`, and collect everything the server sends for `SETTLE_MS`. */
async function exchange(port: number): Promise<{ received: Buffer; stillOpen: boolean }> {
  const socket = net.connect(port, '127.0.0.1');
  const chunks: Buffer[] = [];
  let closed = false;
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(CLIENT_BYTES);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const stillOpen = !closed && !socket.destroyed;
  socket.destroy();
  return { received: Buffer.concat(chunks), stillOpen };
}

describe('fake SMTP server silent mode', () => {
  it('never writes to the socket, even when the client sends CRLF-delimited bytes', async () => {
    server = await startFakeSmtpServer({ mode: 'plain', silent: true });
    const { received, stillOpen } = await exchange(server.port);
    expect(received.toString('latin1')).toBe('');
    // Liveness: the connection was accepted and held open, not refused or dropped.
    expect(stillOpen).toBe(true);
  });

  it('control: a non-silent server answers the same bytes, so the exchange can see replies', async () => {
    server = await startFakeSmtpServer({ mode: 'plain' });
    const { received } = await exchange(server.port);
    const text = received.toString('latin1');
    expect(text).toContain('220 fake.example.com ESMTP test');
    expect(text).toContain('502 5.5.2 Command not recognized');
    expect(text).toContain('250-fake.example.com');
  });
});
