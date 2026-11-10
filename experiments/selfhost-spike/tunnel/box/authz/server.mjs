// Stand-in for a SAM callback route that frps's server plugin calls on Login and NewProxy.
// Per-node token = HMAC(secret, nodeId) here; in SAM it would be the node callback JWT
// (verifyCallbackToken, scope 'node') or a dedicated per-node frp credential.
// Leases stand in for a D1 table: each node may claim exactly its assigned port / domain.
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.AUTHZ_SECRET || 'spike-authz-secret';
const LEASES = JSON.parse(process.env.LEASES || '{"node-a":{"port":17001,"domain":"node-a.nodes.internal"},"node-b":{"port":17002,"domain":"node-b.nodes.internal"},"node-c":{"port":17003,"domain":"node-c.nodes.internal"}}');
const ALLOWED_TYPES = new Set(['tcp', 'http', 'tcpmux']);
export const tokenFor = (nodeId) => crypto.createHmac('sha256', SECRET).update(nodeId).digest('hex');

function verifyNode(metas) {
  const nodeId = metas?.nodeId, token = metas?.nodeToken || '';
  if (!nodeId || !LEASES[nodeId]) return { error: `unknown node ${nodeId}` };
  const want = Buffer.from(tokenFor(nodeId)), got = Buffer.from(token);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { error: `bad token for ${nodeId}` };
  return { nodeId, lease: LEASES[nodeId] };
}

function decide(op, c) {
  if (op === 'Login') {
    const v = verifyNode(c.metas);
    return v.error ? v.error : null;
  }
  if (op === 'NewProxy') {
    // Re-verify on every proxy: NewProxy carries the login metas, so no server-side session state is needed.
    const v = verifyNode(c.user?.metas);
    if (v.error) return v.error;
    const { nodeId, lease } = v;
    if (!ALLOWED_TYPES.has(c.proxy_type)) return `proxy type ${c.proxy_type} not allowed`;
    if (!c.proxy_name?.startsWith(`${nodeId}-`)) return `proxy name ${c.proxy_name} not owned by ${nodeId}`;
    if (c.proxy_type === 'tcp' && c.remote_port !== lease.port) return `${nodeId} may only bind port ${lease.port}, claimed ${c.remote_port}`;
    if (c.proxy_type !== 'tcp') {
      const doms = c.custom_domains || [];
      if (c.subdomain || doms.length !== 1 || doms[0] !== lease.domain) return `${nodeId} may only claim ${lease.domain}, claimed ${JSON.stringify(doms)} sub=${c.subdomain || ''}`;
    }
    return null;
  }
  return null;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const op = new URL(req.url, 'http://x').searchParams.get('op');
    let reason;
    try { reason = decide(op, JSON.parse(body).content); } catch (e) { reason = `malformed: ${e.message}`; }
    const out = reason ? { reject: true, reject_reason: reason } : { reject: false, unchange: true };
    console.log(JSON.stringify({ t: new Date().toISOString(), op, decision: reason ? 'reject' : 'allow', reason }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out));
  });
}).listen(Number(process.env.PORT || 7600), '127.0.0.1', () => console.log('authz listening'));
