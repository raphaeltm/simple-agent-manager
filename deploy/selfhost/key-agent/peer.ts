/**
 * Who is on the other end of a loopback TCP connection. Linux has SO_PEERCRED for unix sockets
 * only, and a celld Worker can reach this agent only over TCP (celld's `fetch` and
 * `cloudflare:sockets` take host:port, not a socket path). For a connection between two sockets
 * on this host the client's socket is listed in /proc/net/tcp with its owner's uid, so the agent
 * looks the client up there. The agent runs on the host network, so its /proc/net/tcp is the
 * host's.
 */
import { readFileSync } from 'node:fs';

/** `127.0.0.1:port` as /proc/net/tcp writes it: little-endian address word, big-endian port. */
function procAddress(ipv4: string, port: number): string | null {
  const octets = ipv4.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  const word = octets
    .reverse()
    .map((o) => o.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `${word}:${port.toString(16).padStart(4, '0').toUpperCase()}`;
}

/**
 * The uid owning the client socket `clientAddress:clientPort` connected to
 * `serverAddress:serverPort`, or null when no such socket is listed (or the table is unreadable).
 * Callers must treat null as "refuse".
 */
export function loopbackPeerUid(
  connection: { clientAddress: string; clientPort: number; serverAddress: string; serverPort: number },
  procNetTcp = '/proc/net/tcp',
  read: (path: string) => string = (path) => readFileSync(path, 'utf8')
): number | null {
  const client = procAddress(connection.clientAddress.replace(/^::ffff:/, ''), connection.clientPort);
  const server = procAddress(connection.serverAddress.replace(/^::ffff:/, ''), connection.serverPort);
  if (!client || !server) return null;
  let table: string;
  try {
    table = read(procNetTcp);
  } catch {
    return null;
  }
  let found: number | null = null;
  for (const line of table.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
    // Only ESTABLISHED (01): a TIME_WAIT entry from an earlier connection on the same client port
    // is listed with uid 0 and must not decide.
    if (columns.length < 8 || columns[1] !== client || columns[2] !== server || columns[3] !== '01') {
      continue;
    }
    const uid = Number(columns[7]);
    if (!Number.isInteger(uid)) return null;
    // Two live sockets cannot share one 4-tuple; a duplicate means the table is not what we think.
    if (found !== null && found !== uid) return null;
    found = uid;
  }
  return found;
}
