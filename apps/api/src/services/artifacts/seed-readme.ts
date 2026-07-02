/**
 * Seeds an initial README commit into a freshly-created (empty) Cloudflare
 * Artifacts Git repository.
 *
 * Why this exists: `ARTIFACTS.create()` returns an *empty* repo with no commits
 * and therefore no default branch ref. The VM agent bootstrap clones with
 * `git clone --branch <defaultBranch>` (`packages/vm-agent/internal/bootstrap/bootstrap.go`),
 * which fails against an empty repo because the branch does not exist yet.
 * Seeding a single initial commit creates the default branch ref and gives
 * agents a README that orients them (project name, description, and the SAM MCP
 * tools they should use).
 *
 * Cloudflare Workers cannot shell out to `git`, so this module speaks the Git
 * smart-HTTP `git-receive-pack` protocol directly: it builds the three Git
 * objects (blob → tree → commit), assembles a packfile, and POSTs a ref-update
 * command plus the pack. SHA-1 is computed with Web Crypto and object payloads
 * are zlib-compressed with `CompressionStream('deflate')` — both available in
 * the Workers runtime.
 *
 * Git object ids are still computed over the loose format
 * `<type> <size>\0<content>`; the packfile only omits that header from the
 * stored (compressed) bytes.
 */

const encoder = new TextEncoder();

const ZERO_OID = '0'.repeat(40);

// Git pack object type numbers.
const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

/** Default committer identity for seeded commits. */
export const SEED_AUTHOR_NAME = 'SAM';
export const SEED_AUTHOR_EMAIL = 'noreply@simple-agent-manager.org';
export const SEED_COMMIT_MESSAGE = 'Initial commit\n';

export interface SeedReadmeParams {
  /** Full Artifacts clone URL, e.g. https://acct.artifacts.cloudflare.net/git/default/repo.git */
  remote: string;
  /** Write-scoped Artifacts token returned by ARTIFACTS.create(). */
  token: string;
  /** Default branch to create, e.g. "main". */
  branch: string;
  /** Human-readable project name. */
  projectName: string;
  /** Optional project description supplied by the user. */
  description?: string | null;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-1', data as unknown as BufferSource);
  return new Uint8Array(digest);
}

/** Git object id: SHA-1 over the loose format `<type> <size>\0<content>`. */
async function objectId(type: string, content: Uint8Array): Promise<string> {
  const header = encoder.encode(`${type} ${content.length}\0`);
  return bytesToHex(await sha1Bytes(concatBytes([header, content])));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const compressed = new Response(data as unknown as BodyInit).body!.pipeThrough(cs);
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

/**
 * Encodes the variable-length pack object header (type + uncompressed size).
 * First byte carries the 3-bit type and the low 4 size bits; subsequent bytes
 * carry 7 size bits each, MSB set while more bytes follow.
 */
function packObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16); // size >>> 4 (safe for >2GB, though seeds are tiny)
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size = Math.floor(size / 128); // size >>> 7
  }
  bytes.push(byte);
  return Uint8Array.from(bytes);
}

interface PackObject {
  type: number;
  content: Uint8Array;
}

async function buildPack(objects: PackObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  header.set(encoder.encode('PACK'), 0);
  view.setUint32(4, 2); // version
  view.setUint32(8, objects.length);

  const parts: Uint8Array[] = [header];
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.content.length));
    parts.push(await deflate(obj.content));
  }
  const body = concatBytes(parts);
  const trailer = await sha1Bytes(body);
  return concatBytes([body, trailer]);
}

/** Wraps a payload in a Git pkt-line (4-hex length prefix, length-inclusive). */
function pktLine(payload: Uint8Array): Uint8Array {
  const len = payload.length + 4;
  const hex = len.toString(16).padStart(4, '0');
  return concatBytes([encoder.encode(hex), payload]);
}

const FLUSH_PKT = encoder.encode('0000');

/** Builds the README shown to agents opening a fresh Artifacts-backed repo. */
export function buildReadmeContent(projectName: string, description?: string | null): string {
  const trimmedDescription = description?.trim();
  const lines: string[] = [`# ${projectName}`, ''];

  if (trimmedDescription) {
    lines.push(trimmedDescription, '');
  }

  lines.push(
    'This repository is hosted by [SAM (Simple Agent Manager)](https://simple-agent-manager.org)',
    'using Cloudflare Artifacts — a serverless Git host. It was created without a GitHub',
    'connection, so GitHub-specific tooling (the `gh` CLI, pull requests) does not apply here.',
    '',
    '## For agents working in this repository',
    '',
    'You are running inside a SAM workspace. Use the SAM MCP tools to understand your',
    'environment and coordinate work:',
    '',
    '- `get_instructions` — your task context, project info, and how to report progress. **Call this first.**',
    '- `get_workspace_info` / `get_network_info` — details about the workspace you are running in.',
    '- `dispatch_task` — spawn follow-up work to other agents.',
    '- `update_task_status` — report significant findings and progress.',
    '- `search_knowledge` / `add_knowledge` — recall and remember facts about this project across sessions.',
    '- `create_idea` / `list_ideas` — capture and track product or engineering ideas.',
    '',
    'Commit your work directly to this repository as you go — push to the remote branch',
    'rather than opening a pull request. This repo is the source of truth for the project.',
    ''
  );

  return lines.join('\n');
}

interface SeedObjects {
  pack: Uint8Array;
  commitOid: string;
}

/**
 * Builds the packfile and resolved commit oid for a README seed. Exported for
 * tests that validate the pack against a real `git receive-pack`.
 */
export async function buildSeedPack(params: {
  projectName: string;
  description?: string | null;
  now?: Date;
}): Promise<SeedObjects> {
  const readme = buildReadmeContent(params.projectName, params.description);
  const blobContent = encoder.encode(readme);
  const blobOid = await objectId('blob', blobContent);

  // Tree with a single entry: `100644 README.md\0<20 raw sha bytes>`.
  const treeContent = concatBytes([
    encoder.encode('100644 README.md\0'),
    hexToBytes(blobOid),
  ]);
  const treeOid = await objectId('tree', treeContent);

  const timestamp = Math.floor((params.now?.getTime() ?? Date.now()) / 1000);
  const identity = `${SEED_AUTHOR_NAME} <${SEED_AUTHOR_EMAIL}> ${timestamp} +0000`;
  const commitContent = encoder.encode(
    `tree ${treeOid}\n` +
      `author ${identity}\n` +
      `committer ${identity}\n` +
      '\n' +
      SEED_COMMIT_MESSAGE
  );
  const commitOid = await objectId('commit', commitContent);

  const pack = await buildPack([
    { type: OBJ_COMMIT, content: commitContent },
    { type: OBJ_TREE, content: treeContent },
    { type: OBJ_BLOB, content: blobContent },
  ]);

  return { pack, commitOid };
}

/**
 * Builds the raw `git-receive-pack` request body (ref-update command + flush +
 * packfile). Exported for tests.
 */
export function buildReceivePackRequest(commitOid: string, branch: string, pack: Uint8Array): Uint8Array {
  const command = encoder.encode(
    `${ZERO_OID} ${commitOid} refs/heads/${branch}\0report-status\n`
  );
  return concatBytes([pktLine(command), FLUSH_PKT, pack]);
}

/**
 * Detects a failed ref update in the pkt-line-encoded receive-pack result.
 * The server reports `unpack ok` and `ok <ref>` on success, or `ng <ref> ...`
 * on failure. Exported for tests.
 */
export function parseReceivePackResult(body: string): { ok: boolean; detail: string } {
  if (/(^|\n|\r|\x00|[0-9a-f]{4})ng /.test(body) || body.includes('ng refs/')) {
    return { ok: false, detail: body.trim() };
  }
  if (body.includes('unpack ok') || body.includes('ok refs/')) {
    return { ok: true, detail: body.trim() };
  }
  // An empty/unrecognized body is treated as failure so callers surface it.
  return { ok: false, detail: body.trim() || 'empty receive-pack response' };
}

/**
 * Seeds an initial README commit into an empty Artifacts repo via the Git
 * smart-HTTP `git-receive-pack` endpoint. Throws on any transport or ref-update
 * failure so the caller can treat the repo as unusable.
 */
export async function seedArtifactsReadme(params: SeedReadmeParams): Promise<void> {
  const { remote, token, branch, projectName, description } = params;
  const doFetch = params.fetchImpl ?? fetch;

  const { pack, commitOid } = await buildSeedPack({
    projectName,
    description,
    now: params.now,
  });
  const requestBody = buildReceivePackRequest(commitOid, branch, pack);

  const url = `${remote.replace(/\/$/, '')}/git-receive-pack`;
  const auth = btoa(`x:${token}`);

  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-git-receive-pack-request',
      Accept: 'application/x-git-receive-pack-result',
      Authorization: `Basic ${auth}`,
    },
    body: requestBody as unknown as BodyInit,
  });

  const resultText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Artifacts receive-pack HTTP ${response.status}: ${resultText.slice(0, 500)}`
    );
  }

  const result = parseReceivePackResult(resultText);
  if (!result.ok) {
    throw new Error(`Artifacts receive-pack ref update failed: ${result.detail.slice(0, 500)}`);
  }
}
