#!/usr/bin/env node
/**
 * Minimal OCI Distribution v2 registry receiver — SPIKE ONLY.
 *
 * Purpose: receive whatever `docker compose publish` (and `docker compose push`)
 * sends, persist every blob + manifest to disk, and log media types / digests /
 * sizes so we can inspect exactly what artifacts compose produces and decide
 * whether SAM can interpret them.
 *
 * This is NOT production code. It implements just enough of the push half of the
 * OCI distribution spec to accept a push:
 *   GET  /v2/                                  -> version check
 *   POST /v2/<name>/blobs/uploads/             -> start upload (monolithic or chunked)
 *   PATCH /v2/<name>/blobs/uploads/<uuid>      -> append chunk
 *   PUT  /v2/<name>/blobs/uploads/<uuid>?digest=... -> finalize blob
 *   HEAD /v2/<name>/blobs/<digest>             -> existence check (we say 404 to force upload)
 *   GET  /v2/<name>/blobs/<digest>             -> serve blob (for digest resolution)
 *   PUT  /v2/<name>/manifests/<reference>      -> store manifest
 *   HEAD /v2/<name>/manifests/<reference>      -> existence check
 *   GET  /v2/<name>/manifests/<reference>      -> serve manifest
 *
 * All received bytes land under ./_captured/{blobs,manifests,uploads,log.jsonl}.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5050);
const CAP = path.join(__dirname, '_captured');
const BLOBS = path.join(CAP, 'blobs');
const MANIFESTS = path.join(CAP, 'manifests');
const UPLOADS = path.join(CAP, 'uploads');
const LOG = path.join(CAP, 'log.jsonl');

for (const d of [CAP, BLOBS, MANIFESTS, UPLOADS]) fs.mkdirSync(d, { recursive: true });
// Truncate log on boot so each run is clean.
fs.writeFileSync(LOG, '');

function log(event) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  fs.appendFileSync(LOG, line + '\n');
  // Compact console line.
  const { type, method, url, name, reference, digest, mediaType, size } = event;
  console.log(
    `[${type}] ${method || ''} ${url || ''}` +
      (name ? ` name=${name}` : '') +
      (reference ? ` ref=${reference}` : '') +
      (digest ? ` digest=${digest}` : '') +
      (mediaType ? ` mediaType=${mediaType}` : '') +
      (size != null ? ` size=${size}` : ''),
  );
}

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// digest (sha256:hex) -> safe filename
function digestFile(dir, digest) {
  return path.join(dir, digest.replace(':', '_'));
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const method = req.method;

  try {
    // --- version check ---
    if (pathname === '/v2/' || pathname === '/v2') {
      log({ type: 'v2-check', method, url: pathname });
      res.writeHead(200, { 'Docker-Distribution-Api-Version': 'registry/2.0' });
      return res.end('{}');
    }

    // --- blob upload start: POST /v2/<name>/blobs/uploads/ ---
    let m = pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/?$/);
    if (m && method === 'POST') {
      const name = m[1];
      const mountDigest = url.searchParams.get('mount');
      const fromRepo = url.searchParams.get('from');
      // Monolithic upload: POST with digest query + body in one shot.
      const monoDigest = url.searchParams.get('digest');
      if (mountDigest) {
        // We never have it mounted -> fall back to requesting a fresh upload.
        log({ type: 'blob-mount-miss', method, url: pathname, name, digest: mountDigest, from: fromRepo });
      }
      if (monoDigest) {
        const body = await readBody(req);
        const actual = sha256(body);
        fs.writeFileSync(digestFile(BLOBS, monoDigest), body);
        log({ type: 'blob-monolithic', method, url: pathname, name, digest: monoDigest, computed: actual, size: body.length, match: actual === monoDigest });
        res.writeHead(201, { Location: `/v2/${name}/blobs/${monoDigest}`, 'Docker-Content-Digest': monoDigest });
        return res.end();
      }
      const uuid = crypto.randomUUID();
      fs.writeFileSync(path.join(UPLOADS, uuid), Buffer.alloc(0));
      log({ type: 'upload-start', method, url: pathname, name, uuid });
      res.writeHead(202, {
        Location: `/v2/${name}/blobs/uploads/${uuid}`,
        'Docker-Upload-Uuid': uuid,
        Range: '0-0',
      });
      return res.end();
    }

    // --- blob upload chunk/finalize: PATCH/PUT /v2/<name>/blobs/uploads/<uuid> ---
    m = pathname.match(/^\/v2\/(.+)\/blobs\/uploads\/([^/]+)$/);
    if (m && (method === 'PATCH' || method === 'PUT')) {
      const name = m[1];
      const uuid = m[2];
      const partPath = path.join(UPLOADS, uuid);
      const existing = fs.existsSync(partPath) ? fs.readFileSync(partPath) : Buffer.alloc(0);
      const body = await readBody(req);
      const combined = Buffer.concat([existing, body]);
      fs.writeFileSync(partPath, combined);

      if (method === 'PATCH') {
        log({ type: 'upload-chunk', method, url: pathname, name, uuid, size: body.length, total: combined.length });
        res.writeHead(202, {
          Location: `/v2/${name}/blobs/uploads/${uuid}`,
          'Docker-Upload-Uuid': uuid,
          Range: `0-${combined.length - 1}`,
        });
        return res.end();
      }

      // PUT finalize
      const digest = url.searchParams.get('digest');
      const actual = sha256(combined);
      fs.writeFileSync(digestFile(BLOBS, digest || actual), combined);
      fs.unlinkSync(partPath);
      log({ type: 'blob-finalize', method, url: pathname, name, digest, computed: actual, size: combined.length, match: actual === digest });
      res.writeHead(201, { Location: `/v2/${name}/blobs/${digest}`, 'Docker-Content-Digest': digest || actual });
      return res.end();
    }

    // --- blob existence / fetch: HEAD|GET /v2/<name>/blobs/<digest> ---
    m = pathname.match(/^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]+)$/);
    if (m && (method === 'HEAD' || method === 'GET')) {
      const name = m[1];
      const digest = m[2];
      const f = digestFile(BLOBS, digest);
      if (fs.existsSync(f)) {
        const buf = fs.readFileSync(f);
        log({ type: 'blob-' + (method === 'HEAD' ? 'head-hit' : 'get'), method, url: pathname, name, digest, size: buf.length });
        res.writeHead(200, { 'Content-Length': buf.length, 'Docker-Content-Digest': digest, 'Content-Type': 'application/octet-stream' });
        return res.end(method === 'HEAD' ? undefined : buf);
      }
      log({ type: 'blob-head-miss', method, url: pathname, name, digest });
      res.writeHead(404);
      return res.end();
    }

    // --- manifest: PUT|HEAD|GET /v2/<name>/manifests/<reference> ---
    m = pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (m) {
      const name = m[1];
      const reference = m[2];
      if (method === 'PUT') {
        const body = await readBody(req);
        const mediaType = req.headers['content-type'] || 'unknown';
        const digest = sha256(body);
        // Store by digest AND record the tag->digest mapping for inspection.
        fs.writeFileSync(digestFile(MANIFESTS, digest), body);
        const tagFile = path.join(MANIFESTS, `${name.replace(/\//g, '_')}__${reference}.json`);
        fs.writeFileSync(tagFile, body);
        log({ type: 'manifest-put', method, url: pathname, name, reference, digest, mediaType, size: body.length });
        // Also parse + log the descriptor list so we see the topology of the artifact.
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          log({ type: 'manifest-parsed', name, reference, digest, summary: summarizeManifest(parsed) });
        } catch {
          /* not json (e.g. could be other) */
        }
        res.writeHead(201, { Location: `/v2/${name}/manifests/${reference}`, 'Docker-Content-Digest': digest });
        return res.end();
      }
      if (method === 'HEAD' || method === 'GET') {
        const tagFile = path.join(MANIFESTS, `${name.replace(/\//g, '_')}__${reference}.json`);
        const byDigest = reference.startsWith('sha256:') ? digestFile(MANIFESTS, reference) : null;
        const f = byDigest && fs.existsSync(byDigest) ? byDigest : tagFile;
        if (fs.existsSync(f)) {
          const buf = fs.readFileSync(f);
          let mediaType = 'application/vnd.oci.image.manifest.v1+json';
          try {
            mediaType = JSON.parse(buf.toString('utf8')).mediaType || mediaType;
          } catch {}
          log({ type: 'manifest-' + (method === 'HEAD' ? 'head-hit' : 'get'), method, url: pathname, name, reference, size: buf.length, mediaType });
          res.writeHead(200, { 'Content-Type': mediaType, 'Content-Length': buf.length, 'Docker-Content-Digest': sha256(buf) });
          return res.end(method === 'HEAD' ? undefined : buf);
        }
        log({ type: 'manifest-miss', method, url: pathname, name, reference });
        res.writeHead(404);
        return res.end();
      }
    }

    // --- catch-all: log anything unexpected so we don't miss part of the protocol ---
    const body = await readBody(req);
    log({ type: 'UNHANDLED', method, url: pathname, size: body.length, headers: req.headers });
    res.writeHead(404);
    res.end();
  } catch (err) {
    log({ type: 'ERROR', method, url: pathname, error: String(err && err.stack ? err.stack : err) });
    res.writeHead(500);
    res.end();
  }
};

function summarizeManifest(m) {
  // Works for image manifests, image indexes, and compose's artifact manifests.
  const out = { mediaType: m.mediaType, schemaVersion: m.schemaVersion, artifactType: m.artifactType };
  if (m.config) out.config = { mediaType: m.config.mediaType, digest: m.config.digest, size: m.config.size };
  if (Array.isArray(m.layers)) {
    out.layers = m.layers.map((l) => ({ mediaType: l.mediaType, digest: l.digest, size: l.size, annotations: l.annotations }));
  }
  if (Array.isArray(m.manifests)) {
    out.manifests = m.manifests.map((d) => ({ mediaType: d.mediaType, digest: d.digest, size: d.size, platform: d.platform, annotations: d.annotations }));
  }
  if (m.subject) out.subject = m.subject;
  if (m.annotations) out.annotations = m.annotations;
  return out;
}

// Serve HTTPS if certs are present (compose publish's artifact client requires
// TLS even for localhost). Fall back to HTTP otherwise.
const CERT = path.join(__dirname, 'certs', 'cert.pem');
const KEY = path.join(__dirname, 'certs', 'key.pem');
let server;
if (fs.existsSync(CERT) && fs.existsSync(KEY)) {
  server = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OCI receiver listening on https://localhost:${PORT} (TLS)`);
    console.log(`Capturing to ${CAP}`);
  });
} else {
  server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`OCI receiver listening on http://localhost:${PORT}`);
    console.log(`Capturing to ${CAP}`);
  });
}
