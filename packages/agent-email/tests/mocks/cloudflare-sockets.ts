/**
 * `cloudflare:sockets` exists only in the Workers runtime. Unit tests here never open an SMTP
 * connection (the real-socket SMTP tests live in apps/api with a Node-backed double), so any call
 * is a test bug.
 */
export function connect(): never {
  throw new Error('cloudflare:sockets is not available in agent-email unit tests');
}
