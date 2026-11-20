/**
 * Conformance of the SAM-hosted git server with a real git client.
 *
 * Everything below drives the stock `git` CLI over HTTP against the HostedGitRepo Durable Object
 * running in Miniflare, through the same authenticated route production mounts at
 * `https://api.<BASE_DOMAIN>/git/<repo>.git`. Repositories are created through the real
 * project-create route (artifacts provider, an email-only user with no GitHub link), which seeds
 * the README in-process; workspace credentials come from the real POST /workspaces/:id/git-token.
 */
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve as scratchResolve } from 'node:path';
const tmpdir = () => {
  const dir = scratchResolve(import.meta.dirname, '../../../../.tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
};
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES,
  DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS,
} from '../../src/selfhost/hosted-git/limits';
import { buildReceivePackRequest,buildSeedPack } from '../../src/services/artifacts/seed-readme';
import {
  HOSTED_GIT_TEST_BASE_DOMAIN,
  HOSTED_GIT_TEST_TOKEN_TTL_SECONDS,
  type HostedGitRuntime,
  startHostedGitRuntime,
} from './support/hosted-git-runtime';

const execFileAsync = promisify(execFile);

let runtime: HostedGitRuntime;
let scratch: string;
/** Fake public forge: https://github.com/sam-test/<name>.git is served from a hosted repo. */
const fakeForge = new Map<string, { repo: string; token: string }>();

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git with no ambient credentials, prompts or config. */
async function git(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        'protocol.version=2',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        ...args,
      ],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: scratch,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      }
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

async function gitOk(args: string[], cwd?: string): Promise<GitResult> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(
      `git failed (${result.code}):\n${result.stderr.replace(/samgit1\.[A-Za-z0-9_.-]+/g, '[redacted]').replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')}`
    );
  }
  return result;
}

/** A local URL for a repository remote, with the token as the Basic password. */
function localRemote(remote: string, token?: string): string {
  const url = new URL(remote);
  const local = new URL(runtime.origin);
  local.pathname = url.pathname;
  if (token) {
    local.username = 'x';
    local.password = token;
  }
  return local.toString();
}

async function mintToken(
  project: { artifactsRepoId: string; ownerId: string },
  scope: 'read' | 'write',
  extra: { ttlSeconds?: number; workspaceId?: string; userId?: string } = {}
): Promise<string> {
  const res = await runtime.fetch('/__test/hosted-git-token', {
    method: 'POST',
    body: JSON.stringify({
      repo: project.artifactsRepoId,
      scope,
      userId: project.ownerId,
      ...extra,
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

let userCounter = 0;
async function createEmailOnlyUser(): Promise<string> {
  userCounter += 1;
  const id = `user-hosted-git-${userCounter}`;
  await runtime.DATABASE.prepare(
    `INSERT INTO users (id, email, email_verified, name, role, status, created_at, updated_at)
     VALUES (?, ?, 1, ?, 'user', 'active', ?, ?)`
  )
    .bind(id, `${id}@example.com`, id, Date.now(), Date.now())
    .run();
  return id;
}

interface CreatedProject {
  id: string;
  ownerId: string;
  repository: string;
  artifactsRepoId: string;
  defaultBranch: string;
}

async function createHostedProject(userId: string, name: string): Promise<CreatedProject> {
  const res = await runtime.fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
    body: JSON.stringify({ name, repoProvider: 'artifacts', description: 'Hosted repo test' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(201);
  const row = await runtime.DATABASE.prepare(
    `SELECT id, repository, artifacts_repo_id AS artifactsRepoId, default_branch AS defaultBranch
       FROM projects WHERE id = ?`
  )
    .bind(body.id)
    .first<CreatedProject>();
  expect(row).not.toBeNull();
  return { ...row!, ownerId: userId };
}

async function freshDir(name: string): Promise<string> {
  const dir = join(scratch, `${name}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sam-hosted-git-client-'));
  runtime = await startHostedGitRuntime(async (request) => {
    const url = new URL(request.url);
    const match = /^\/sam-test\/([^/]+?)(?:\.git)?(\/.*)$/.exec(url.pathname);
    const source = url.hostname === 'github.com' && match ? fakeForge.get(match[1]!) : undefined;
    if (!source) return new Response('not found', { status: 404 });
    const headers = new Headers(request.headers);
    headers.set('authorization', `Basic ${btoa(`x:${source.token}`)}`);
    // Node's fetch sets these itself and refuses a forwarded content-length
    // ("invalid content-length header") on the POST git sends for protocol v2 ls-refs.
    headers.delete('content-length');
    headers.delete('host');
    return fetch(`${runtime.origin}/git/${source.repo}.git${match![2]}${url.search}`, {
      method: request.method,
      headers,
      body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
    });
  });
});

afterAll(async () => {
  await runtime?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('SAM-hosted repositories with a real git client', () => {
  let owner: string;
  let project: CreatedProject;

  beforeAll(async () => {
    owner = await createEmailOnlyUser();
    project = await createHostedProject(owner, 'Hosted Conformance');
  });

  it('creates the project with a hosted remote under api.<BASE_DOMAIN> and seeds a README', async () => {
    expect(project.repository).toBe(
      `https://api.${HOSTED_GIT_TEST_BASE_DOMAIN}/git/${project.artifactsRepoId}.git`
    );
    const token = await mintToken(project, 'read');
    const dir = await freshDir('clone');
    await gitOk(['clone', localRemote(project.repository, token), dir]);
    const readme = await readFile(join(dir, 'README.md'), 'utf8');
    expect(readme).toContain('Hosted Conformance');
    const branch = await gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    expect(branch.stdout.trim()).toBe(project.defaultBranch);
    const fsck = await git(['fsck', '--strict'], dir);
    expect(fsck.code).toBe(0);
  });

  it('pushes a branch, then shallow-clones and fetches it', async () => {
    const token = await mintToken(project, 'write');
    const work = await freshDir('work');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    await gitOk(['checkout', '-b', 'feature/one'], work);
    for (let i = 0; i < 3; i++) {
      await writeFile(join(work, `file-${i}.txt`), `content ${i}\n`);
      await gitOk(['add', '.'], work);
      await gitOk(['commit', '-m', `commit ${i}`], work);
    }
    await gitOk(['push', 'origin', 'feature/one'], work);
    const head = (await gitOk(['rev-parse', 'HEAD'], work)).stdout.trim();

    const shallow = await freshDir('shallow');
    await gitOk(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        'feature/one',
        localRemote(project.repository, token),
        shallow,
      ],
      undefined
    );
    expect((await gitOk(['rev-parse', 'HEAD'], shallow)).stdout.trim()).toBe(head);
    expect((await gitOk(['rev-list', '--count', 'HEAD'], shallow)).stdout.trim()).toBe('1');

    // A new commit on the server, then fetch it into the shallow clone.
    await writeFile(join(work, 'later.txt'), 'later\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'later'], work);
    await gitOk(['push', 'origin', 'feature/one'], work);
    const later = (await gitOk(['rev-parse', 'HEAD'], work)).stdout.trim();
    await gitOk(['fetch', 'origin', 'feature/one'], shallow);
    expect((await gitOk(['rev-parse', 'FETCH_HEAD'], shallow)).stdout.trim()).toBe(later);

    // A full clone sees every branch and passes fsck.
    const full = await freshDir('full');
    await gitOk(['clone', localRemote(project.repository, token), full]);
    const branches = (await gitOk(['branch', '-r'], full)).stdout;
    expect(branches).toContain('origin/feature/one');
    expect((await git(['fsck', '--strict'], full)).code).toBe(0);
  });

  it('refuses an unauthenticated clone', async () => {
    const dir = await freshDir('anon');
    const result = await git(['clone', localRemote(project.repository), dir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Authentication failed|could not read Username|401/);
  });

  it('refuses a push with a read-scoped token, and accepts the same push with write scope', async () => {
    const read = await mintToken(project, 'read');
    const work = await freshDir('readonly');
    await gitOk(['clone', localRemote(project.repository, read), work]);
    await writeFile(join(work, 'nope.txt'), 'nope\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'nope'], work);
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/read-only'], work);
    expect(refused.code).not.toBe(0);

    const write = await mintToken(project, 'write');
    await gitOk(['remote', 'set-url', 'origin', localRemote(project.repository, write)], work);
    await gitOk(['push', 'origin', 'HEAD:refs/heads/read-only'], work);
  });

  it("refuses another project's token, with an owner control", async () => {
    const other = await createHostedProject(await createEmailOnlyUser(), 'Other Tenant');
    const otherToken = await mintToken(other, 'write');
    const attack = await freshDir('attack');
    const refused = await git(['clone', localRemote(project.repository, otherToken), attack]);
    expect(refused.code).not.toBe(0);

    // Owner control: the same token works on its own repository.
    const control = await freshDir('control');
    await gitOk(['clone', localRemote(other.repository, otherToken), control]);
    expect(await readFile(join(control, 'README.md'), 'utf8')).toContain('Other Tenant');
  });

  it('refuses an expired or tampered token', async () => {
    const token = await mintToken(project, 'read');
    const [prefix, payload, signature] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    forged.repo = 'someone-else';
    const tampered = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    const res = await runtime.fetch(
      `/git/${project.artifactsRepoId}.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Basic ${btoa(`x:${tampered}`)}` } }
    );
    expect(res.status).toBe(401);
    const ok = await runtime.fetch(
      `/git/${project.artifactsRepoId}.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Basic ${btoa(`x:${token}`)}` } }
    );
    expect(ok.status).toBe(200);
  });

  it('refuses a small compressed pack with an oversized commit, then accepts a normal push', async () => {
    const user = await createEmailOnlyUser();
    const target = await createHostedProject(user, 'Inflation bound');
    const token = await mintToken(target, 'write');
    const work = await freshDir('compressed-object');
    await gitOk(['clone', localRemote(target.repository, token), work]);
    // A 17 MiB commit message compresses to a tiny pack, below the 64 MiB wire cap.
    // Fixture stays fixed so raising/removing the 16 MiB object guard fails this test.
    await writeFile(join(work, 'message'), 'a'.repeat(17 * 1024 * 1024));
    await gitOk(['commit', '--allow-empty', '-F', 'message'], work);
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/bomb'], work);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('inflated size limit');
    await gitOk(['reset', '--hard', 'origin/main'], work);
    await gitOk(['commit', '--allow-empty', '-m', 'safe'], work);
    await gitOk(['push', 'origin', 'HEAD:refs/heads/safe'], work);
    const refs = await gitOk(['ls-remote', 'origin'], work);
    expect(refs.stdout).toContain('refs/heads/safe');
    expect(refs.stdout).not.toContain('refs/heads/bomb');
  });

  it('refuses a push over the push-size cap with a clear message, and keeps the repository intact', async () => {
    const token = await mintToken(project, 'write');
    const work = await freshDir('big');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    // Incompressible content just over the cap.
    await writeFile(
      join(work, 'big.bin'),
      randomBytes(DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES + 1024 * 1024)
    );
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'big'], work);
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/too-big'], work);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('SAM: push refused');
    expect(refused.stderr).toContain('MiB limit for one push');

    const check = await freshDir('after-big');
    await gitOk(['clone', localRemote(project.repository, token), check]);
    const remoteBranches = (await gitOk(['branch', '-r'], check)).stdout;
    expect(remoteBranches).not.toContain('too-big');
  });

  it('refuses a push that would exceed the object cap, naming the limit', async () => {
    const token = await mintToken(project, 'write');
    const work = await freshDir('many');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    const dir = join(work, 'many');
    await mkdir(dir);
    // One distinct blob per file: more blobs than the cap allows in total.
    for (let i = 0; i <= DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS; i++) {
      await writeFile(join(dir, `f${i}`), `${i}\n`);
    }
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-q', '-m', 'many'], work);
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/too-many'], work);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`${DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS}-object limit`);
  });
});

describe('hosted git hardening (security review findings)', () => {
  let project: CreatedProject;

  beforeAll(async () => {
    project = await createHostedProject(await createEmailOnlyUser(), 'Hardening');
  });

  function infoRefs(token: string): Promise<Response> {
    return runtime.fetch(`/git/${project.artifactsRepoId}.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa(`x:${token}`)}` },
    });
  }

  it('answers a negative pkt-line length promptly with 400 and keeps serving the repository', async () => {
    const token = await mintToken(project, 'write');
    for (const body of ['0004-004', '-001', '0002', '00zz']) {
      const started = Date.now();
      const res = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${btoa(`x:${token}`)}`,
          'content-type': 'application/x-git-receive-pack-request',
        },
        body,
      });
      expect(res.status, body).toBe(400);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
    // Liveness: the same repository still answers.
    expect((await infoRefs(token)).status).toBe(200);
  });

  it('refuses a chunked upload-pack body over the cap without buffering it', async () => {
    const token = await mintToken(project, 'read');
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 20) return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-upload-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`x:${token}`)}` },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect((await infoRefs(token)).status).toBe(200);
  });

  it('refuses a token with no person behind it (internal seeding tokens stay internal)', async () => {
    const res = await runtime.fetch('/__test/hosted-git-token', {
      method: 'POST',
      body: JSON.stringify({ repo: project.artifactsRepoId, scope: 'read' }),
    });
    const { token } = (await res.json()) as { token: string };
    expect((await infoRefs(token)).status).toBe(401);
    expect((await infoRefs(await mintToken(project, 'read'))).status).toBe(200);
  });

  it("refuses a removed member's token, with an active-member control", async () => {
    const member = await createEmailOnlyUser();
    const now = new Date().toISOString();
    await runtime.DATABASE.prepare(
      `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
       VALUES (?, ?, 'maintainer', 'active', ?, ?)`
    )
      .bind(project.id, member, now, now)
      .run();
    const token = await mintToken(project, 'read', { userId: member });
    expect((await infoRefs(token)).status).toBe(200);
    // A write token stops pushing as soon as the member's role loses write access.
    const write = await mintToken(project, 'write', { userId: member });
    const receiveRefs = (t: string) =>
      runtime.fetch(`/git/${project.artifactsRepoId}.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: `Basic ${btoa(`x:${t}`)}` },
      });
    expect((await receiveRefs(write)).status).toBe(200);
    await runtime.DATABASE.prepare(
      `UPDATE project_members SET role = 'viewer' WHERE project_id = ? AND user_id = ?`
    )
      .bind(project.id, member)
      .run();
    expect((await receiveRefs(write)).status).toBe(401);
    expect((await infoRefs(token)).status).toBe(200);

    await runtime.DATABASE.prepare(
      `UPDATE project_members SET status = 'removed', removed_at = ? WHERE project_id = ? AND user_id = ?`
    )
      .bind(now, project.id, member)
      .run();
    expect((await infoRefs(token)).status).toBe(401);
  });
});

describe('browsing a hosted repository through the repo-browse API', () => {
  it('lists branches, the tree and a file, and compares two branches', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'Browse Me');
    const token = await mintToken(project, 'write');
    const work = await freshDir('browse');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    await gitOk(['checkout', '-b', 'feature/browse'], work);
    await mkdir(join(work, 'src'));
    await writeFile(join(work, 'src', 'app.ts'), 'export const answer = 42;\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'add app'], work);
    await gitOk(['push', 'origin', 'feature/browse'], work);

    const get = async (path: string) => {
      const res = await runtime.fetch(`/api/projects/${project.id}${path}`, {
        headers: { 'x-test-user-id': owner },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBe(200);
      return body;
    };
    const branches = (await get('/repo/branches')) as {
      branches: Array<{ name: string; isDefault: boolean }>;
    };
    // Exactly the branches: the list asks the server for refs/heads/ only, so HEAD is never one
    // (box round R13 D11: dgit ignored ref-prefix and "HEAD" showed up as a branch).
    expect(branches.branches).toEqual([
      { name: project.defaultBranch, isDefault: true },
      { name: 'feature/browse', isDefault: false },
    ]);

    const tree = (await get('/repo/tree?ref=feature/browse')) as {
      entries: Array<{ path: string }>;
    };
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('src/app.ts');

    const file = (await get('/repo/file?ref=feature/browse&path=src/app.ts')) as {
      content?: string;
    };
    expect(file.content).toBe('export const answer = 42;\n');

    const compare = (await get(
      `/repo/compare?base=${project.defaultBranch}&head=feature/browse`
    )) as { files: Array<{ path: string; status: string }> };
    expect(compare.files.map((f) => f.path)).toEqual(['src/app.ts']);

    const stranger = await createEmailOnlyUser();
    const denied = await runtime.fetch(`/api/projects/${project.id}/repo/branches`, {
      headers: { 'x-test-user-id': stranger },
    });
    expect([403, 404]).toContain(denied.status);
  });
});

describe('garbage collection', () => {
  it('reclaims the objects of a deleted branch and keeps the repository intact', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'GC Me');
    const token = await mintToken(project, 'write');
    const work = await freshDir('gc');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    await gitOk(['checkout', '-b', 'throwaway'], work);
    for (let i = 0; i < 20; i++) await writeFile(join(work, `junk-${i}.bin`), randomBytes(4096));
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'junk'], work);
    await gitOk(['push', 'origin', 'throwaway'], work);
    type Info = { objects: number };
    const before = (await (
      await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)
    ).json()) as Info;
    await gitOk(['push', 'origin', '--delete', 'throwaway'], work);
    const after = (await (
      await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' })
    ).json()) as Info;
    // 20 blobs + 1 tree + 1 commit were only reachable from the deleted branch.
    expect(before.objects - after.objects).toBeGreaterThanOrEqual(22);

    const check = await freshDir('gc-check');
    await gitOk(['clone', localRemote(project.repository, token), check]);
    expect(await readFile(join(check, 'README.md'), 'utf8')).toContain('GC Me');
    expect((await git(['fsck', '--strict'], check)).code).toBe(0);
  });
});

describe('public import remains unavailable in H2', () => {
  it('refuses importUrl before creating a repository', async () => {
    const owner = await createEmailOnlyUser();
    const res = await runtime.fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': owner },
      body: JSON.stringify({
        name: 'Import unavailable',
        repoProvider: 'artifacts',
        importUrl: 'https://github.com/sam-test/source.git',
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('does not support importUrl');
  });
});

describe('member clone credentials (POST /api/projects/:id/hosted-git/token)', () => {
  it('lets the owner clone and push, and refuses a non-member', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'Member Token');
    const res = await runtime.fetch(`/api/projects/${project.id}/hosted-git/token?scope=write`, {
      method: 'POST',
      headers: { 'x-test-user-id': owner },
    });
    const requestedAt = Date.now();
    const body = (await res.json()) as { token: string; cloneUrl: string; host: string; expiresAt: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.cloneUrl).toBe(project.repository);
    // The personal credential honors the operator's ARTIFACTS_TOKEN_TTL_SECONDS (900 s here),
    // like workspace and browsing credentials, rather than the one-hour default.
    const lifetimeSeconds = (Date.parse(body.expiresAt) - requestedAt) / 1000;
    expect(lifetimeSeconds).toBeGreaterThan(HOSTED_GIT_TEST_TOKEN_TTL_SECONDS - 60);
    expect(lifetimeSeconds).toBeLessThanOrEqual(HOSTED_GIT_TEST_TOKEN_TTL_SECONDS + 1);
    const work = await freshDir('member');
    await gitOk(['clone', localRemote(body.cloneUrl, body.token), work]);
    await writeFile(join(work, 'human.txt'), 'from a laptop\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'human'], work);
    await gitOk(['push', 'origin', 'HEAD'], work);

    // An agent sign-in session cannot mint a credential that outlives it (Codex r4637122062).
    const agentSession = await runtime.fetch(`/api/projects/${project.id}/hosted-git/token?scope=read`, {
      method: 'POST',
      headers: { 'x-test-user-id': owner, 'x-test-agent-sign-in': '1' },
    });
    expect(agentSession.status).toBe(403);

    const stranger = await createEmailOnlyUser();
    const denied = await runtime.fetch(`/api/projects/${project.id}/hosted-git/token`, {
      method: 'POST',
      headers: { 'x-test-user-id': stranger },
    });
    expect([403, 404]).toContain(denied.status);
  });
});

describe('vertical: project creation to a workspace clone and push', () => {
  it('a workspace gets a token from git-token, clones, pushes, and is refused once stopped', async () => {
    const userId = await createEmailOnlyUser();
    const project = await createHostedProject(userId, 'Workspace Flow');
    const now = new Date().toISOString();
    const nodeId = 'node-hosted-git-1';
    const workspaceId = 'ws-hosted-git-1';
    await runtime.DATABASE.prepare(
      `INSERT INTO nodes (id, user_id, name, status, created_at, updated_at)
       VALUES (?, ?, 'node', 'running', ?, ?)`
    )
      .bind(nodeId, userId, now, now)
      .run();
    await runtime.DATABASE.prepare(
      `INSERT INTO workspaces (id, node_id, project_id, user_id, name, repository, branch, status, vm_size, vm_location, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ws', ?, ?, 'running', 'small', 'local', ?, ?)`
    )
      .bind(
        workspaceId,
        nodeId,
        project.id,
        userId,
        project.repository,
        project.defaultBranch,
        now,
        now
      )
      .run();

    const callback = (await (
      await runtime.fetch('/__test/workspace-callback-token', {
        method: 'POST',
        body: JSON.stringify({ workspaceId }),
      })
    ).json()) as { token: string };
    const res = await runtime.fetch(`/api/workspaces/${workspaceId}/git-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${callback.token}` },
    });
    const body = (await res.json()) as {
      token: string;
      cloneUrl: string;
      username?: string;
    };
    expect(res.status, JSON.stringify(body)).toBe(200);
    // What the VM agent's credential helper needs for a host it does not know by name.
    // Main's L16 response: the VM agent derives the credential host from cloneUrl.
    expect(body.cloneUrl).toBe(project.repository);
    expect(new URL(body.cloneUrl).host).toBe(`api.${HOSTED_GIT_TEST_BASE_DOMAIN}`);
    expect(body.username).toBe('x');

    const work = await freshDir('workspace');
    await gitOk([
      'clone',
      '--branch',
      project.defaultBranch,
      localRemote(body.cloneUrl, body.token),
      work,
    ]);
    await gitOk(['checkout', '-b', 'sam/agent-work'], work);
    await writeFile(join(work, 'agent.txt'), 'agent output\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'agent work'], work);
    await gitOk(['push', 'origin', 'sam/agent-work'], work);

    // The pushed branch is visible to a fresh reader.
    const reader = await mintToken(project, 'read');
    const check = await freshDir('verify');
    await gitOk([
      'clone',
      '--branch',
      'sam/agent-work',
      localRemote(project.repository, reader),
      check,
    ]);
    expect(await readFile(join(check, 'agent.txt'), 'utf8')).toBe('agent output\n');

    // Generation fence: a restarted runtime (rotated callback generation) retires the token.
    await runtime.DATABASE.prepare(
      `UPDATE workspaces SET callback_generation = 'rotated' WHERE id = ?`
    )
      .bind(workspaceId)
      .run();
    const retired = await git(['push', 'origin', 'sam/agent-work:refs/heads/after-rotate'], work);
    expect(retired.code).not.toBe(0);
    const fresh = (await (
      await runtime.fetch(`/api/workspaces/${workspaceId}/git-token`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${
            (
              (await (
                await runtime.fetch('/__test/workspace-callback-token', {
                  method: 'POST',
                  body: JSON.stringify({ workspaceId }),
                })
              ).json()) as { token: string }
            ).token
          }`,
        },
      })
    ).json()) as { token: string };
    await gitOk(['remote', 'set-url', 'origin', localRemote(body.cloneUrl, fresh.token)], work);
    await gitOk(['push', 'origin', 'sam/agent-work:refs/heads/after-rotate'], work);

    // Lifecycle fence: once the workspace stops, its token is refused.
    await runtime.DATABASE.prepare(`UPDATE workspaces SET status = 'stopped' WHERE id = ?`)
      .bind(workspaceId)
      .run();
    const refused = await git(['push', 'origin', 'sam/agent-work:refs/heads/after-stop'], work);
    expect(refused.code).not.toBe(0);
  });
});

describe('ref-only push admission', () => {
  it('caps new refs without a pack, while permitting recovery by deleting refs', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'Ref cap');
    const token = await mintToken(project, 'write');
    const work = await freshDir('ref-cap');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    const setting = runtime.DATABASE.prepare(
      "INSERT OR REPLACE INTO platform_settings(key,value) VALUES ('repositories.maxRepoRefs',?)"
    );
    try {
      await setting.bind('2').run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
      await gitOk(['push', 'origin', 'HEAD:refs/heads/second'], work);
      // A stale deletion must not create capacity for a partially accepted mixed push.
      const tip = (await gitOk(['rev-parse', 'HEAD'], work)).stdout.trim();
      const packet = (line: string) =>
        (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line;
      const mixed = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
          'content-type': 'application/x-git-receive-pack-request',
        },
        body:
          packet(`${'1'.repeat(40)} ${'0'.repeat(40)} refs/heads/second\0report-status\n`) +
          packet(`${'0'.repeat(40)} ${tip} refs/heads/third\n`) +
          '0000',
      });
      expect(await mixed.text()).toContain('2-ref limit');
      const refs = (await gitOk(['ls-remote', 'origin'], work)).stdout;
      expect(refs).toContain('refs/heads/second');
      expect(refs).not.toContain('refs/heads/third');
      const refused = await git(['push', 'origin', 'HEAD:refs/heads/third'], work);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain('2-ref limit');
      expect((await gitOk(['ls-remote', 'origin'], work)).stdout).not.toContain('refs/heads/third');
      await gitOk(['push', 'origin', '--delete', 'second'], work);
      await gitOk(['push', 'origin', 'HEAD:refs/heads/third'], work);
    } finally {
      await runtime.DATABASE.prepare(
        "DELETE FROM platform_settings WHERE key='repositories.maxRepoRefs'"
      ).run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
  });
});


describe('Git ref-name admission through smart HTTP', () => {
  it('rejects every .lock path component and accepts a similar valid ref', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Ref names');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const oid = (await gitOk(['ls-remote', remote, 'refs/heads/main'])).stdout.split(/\s+/)[0]!;
    const send = async (branch: string) => (await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` }, body: buildReceivePackRequest(oid, branch, new Uint8Array()) as BodyInit })).text();
    for (const branch of ['foo.lock/bar', 'foo.lock', 'ends-dot.']) {
      expect((await git(['check-ref-format', `refs/heads/${branch}`])).code).not.toBe(0);
      expect(await send(branch)).toContain(`ng refs/heads/${branch} funny refname`);
    }
    for (const branch of ['normal', 'feature/x', 'foo.lockish/bar']) {
      expect((await git(['check-ref-format', `refs/heads/${branch}`])).code).toBe(0);
      expect(await send(branch)).toContain(`ok refs/heads/${branch}`);
    }
    const refs = (await gitOk(['ls-remote', remote])).stdout;
    expect(refs).toContain('refs/heads/foo.lockish/bar');
    expect(refs).not.toContain('refs/heads/foo.lock/bar');
  });
});

describe('repository cleanup through real SQLite', () => {
  it('schedules and reclaims an ingested pack whose only ref update is rejected', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'Rejected pack');
    const token = await mintToken(project, 'write');
    const info = async () => (await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json()) as { objects: number };
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    const idle = await (await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`)).json();
    expect(idle).toMatchObject({ pending: '0', alarm: null });
    const before = await info();
    const { pack, commitOid } = await buildSeedPack({ projectName: 'Unreachable rejected pack' });
    const rejected = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
      method: 'POST', headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`, 'content-type': 'application/x-git-receive-pack-request' },
      body: buildReceivePackRequest(commitOid, 'main', pack) as BodyInit,
    });
    expect(await rejected.text()).toContain('ng refs/heads/main');
    expect((await info()).objects).toBeGreaterThan(before.objects);
    const queued = await (await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`)).json() as { pending: string; alarm: number | null };
    expect(queued.pending).toBe('1'); expect(queued.alarm).not.toBeNull();
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect((await info()).objects).toBe(before.objects);
  });

  it('reclaims a rejected push pack even when migrating the reachable packs exceeds the budget', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'GC budget');
    const token = await mintToken(project, 'write');
    const work = await freshDir('gc-budget');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    // A reachable 5 MiB blob (a few KB packed) that GC would have to inflate to migrate.
    await writeFile(join(work, 'big.txt'), 'b'.repeat(5 * 1024 * 1024));
    await gitOk(['add', 'big.txt'], work);
    await gitOk(['commit', '-q', '-m', 'big'], work);
    await gitOk(['push', 'origin', 'HEAD:refs/heads/main'], work);
    const info = async () =>
      (await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json()) as { objects: number };
    const beforeRejected = await info();
    const { pack, commitOid } = await buildSeedPack({ projectName: 'Rejected under budget' });
    const rejected = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` },
      body: buildReceivePackRequest(commitOid, 'main', pack) as BodyInit,
    });
    expect(await rejected.text()).toContain('ng refs/heads/main');
    expect((await info()).objects).toBeGreaterThan(beforeRejected.objects);
    const gcStateOf = async (p: CreatedProject) =>
      (await (await runtime.fetch(`/__test/gc-state/${p.artifactsRepoId}`)).json()) as { pending: string };
    const setting = "INSERT INTO platform_settings (key,value,updated_at) VALUES ('repositories.maxInflatedBytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
    await runtime.DATABASE.prepare(setting).bind(JSON.stringify(2 * 1024 * 1024), Date.now()).run();
    await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    try {
      // Migration inflates the 5 MiB blob past the 2 MiB budget and fails; the rejected pack
      // was already dropped whole, without inflating anything.
      const has = async (oid: string) =>
        ((await (await runtime.fetch(`/__test/has/${project.artifactsRepoId}/${oid}`)).json()) as { has: boolean }).has;
      expect(await has(commitOid)).toBe(true);
      await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
      // GC failed on the budget (the work is retried), yet the rejected pack is gone. A failed
      // migration can leave loose copies of objects it already moved, so object counts would
      // not show this; the next successful GC removes those copies.
      expect(await has(commitOid)).toBe(false);
      expect((await gcStateOf(project)).pending).toBe('1');
    } finally {
      await runtime.DATABASE.prepare("DELETE FROM platform_settings WHERE key='repositories.maxInflatedBytes'").run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
    // With the default budget the rest of the cleanup completes and the repository still clones.
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect((await info()).objects).toBe(beforeRejected.objects);
    const check = await freshDir('gc-budget-check');
    await gitOk(['clone', localRemote(project.repository, token), check]);
    expect((await readFile(join(check, 'big.txt'), 'utf8')).length).toBe(5 * 1024 * 1024);
  });

  it('lets a packless ref deletion through a lowered push limit (Codex r4637032838)', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Delete under limit');
    const token = await mintToken(project, 'write');
    const work = await freshDir('delete-under-limit');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    await gitOk(['push', 'origin', 'HEAD:refs/heads/to-delete'], work);
    await runtime.DATABASE.prepare(
      "INSERT INTO platform_settings (key,value,updated_at) VALUES ('repositories.maxPushBytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
      .bind(JSON.stringify(1), Date.now())
      .run();
    await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    try {
      await gitOk(['push', 'origin', '--delete', 'to-delete'], work);
      expect((await gitOk(['ls-remote', 'origin'], work)).stdout).not.toContain('refs/heads/to-delete');
      // Control: a push that carries a pack is still held to the 1-byte limit.
      await gitOk(['commit', '--allow-empty', '-q', '-m', 'blocked'], work);
      const refused = await git(['push', 'origin', 'HEAD:refs/heads/blocked'], work);
      expect(refused.code).not.toBe(0);
    } finally {
      await runtime.DATABASE.prepare("DELETE FROM platform_settings WHERE key='repositories.maxPushBytes'").run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
  });

  it('refuses and drops a pack whose index overhead takes stored size past the cap (Codex r4636923076)', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Cap at final write');
    const token = await mintToken(project, 'write');
    const work = await freshDir('cap-final');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    // Thousands of tiny objects: the index rows dwarf the compressed pack, beyond free pages.
    await mkdir(join(work, 'many'), { recursive: true });
    for (let i = 0; i < 3000; i++) await writeFile(join(work, 'many', `f${i}`), `${i} ${randomBytes(4).toString('hex')}\n`);
    await gitOk(['add', 'many'], work);
    await gitOk(['commit', '-q', '-m', 'noise'], work);
    const commit = (await gitOk(['rev-parse', 'HEAD'], work)).stdout.trim();
    const objects = (await gitOk(['rev-list', '--objects', commit, '^HEAD~1'], work)).stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[0]!);
    const pack = spawnSync('git', ['pack-objects', '--stdout'], {
      cwd: work,
      input: `${objects.join('\n')}\n`,
      maxBuffer: 16 * 1024 * 1024,
    }).stdout;
    const info = async () =>
      (await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json()) as { bytes: number };
    const send = () =>
      runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` },
        body: buildReceivePackRequest(commit, 'noise', pack) as BodyInit,
      });
    const setCap = async (cap: number) => {
      await runtime.DATABASE.prepare(
        "INSERT INTO platform_settings (key,value,updated_at) VALUES ('repositories.maxRepoBytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
        .bind(JSON.stringify(cap), Date.now())
        .run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    };
    const before = await info();
    try {
      // The raw pack fits the byte budget exactly; its index rows and pages do not.
      await setCap(before.bytes + pack.length);
      const refused = await (await send()).text();
      expect(refused).toContain('over its');
      expect(refused).toContain('storage limit');
      expect((await gitOk(['ls-remote', localRemote(project.repository, token)])).stdout).not.toContain(
        'refs/heads/noise'
      );
      // The pack was dropped at once, not left holding bytes until GC.
      expect((await info()).bytes).toBeLessThanOrEqual(before.bytes + pack.length);
      // Control: with headroom for the index the same push is accepted.
      await setCap(before.bytes + pack.length + 4 * 1024 * 1024);
      expect(await (await send()).text()).toContain('ok refs/heads/noise');
    } finally {
      await runtime.DATABASE.prepare("DELETE FROM platform_settings WHERE key='repositories.maxRepoBytes'").run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
  });

  it('reclaims failed-ingest pack rows before the next push quota check', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Failed ingest');
    const token = await mintToken(project, 'write');
    const work = await freshDir('failed-ingest');
    await gitOk(['clone', localRemote(project.repository, token), work]);
    const before = await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json() as { bytes: number };
    // A full raw chunk is persisted before checksum validation; the remaining bytes cross quota.
    const pack = randomBytes(2 * 1024 * 1024);
    pack.write('PACK'); pack.writeUInt32BE(2, 4); pack.writeUInt32BE(1, 8);
    const cap = before.bytes + pack.length;
    await runtime.DATABASE.prepare("INSERT INTO platform_settings (key,value,updated_at) VALUES ('repositories.maxRepoBytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(cap), Date.now()).run();
    await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    try {
      const response = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` }, body: buildReceivePackRequest('a'.repeat(40), 'bad', pack) as BodyInit });
      expect(await response.text()).toContain('checksum mismatch');
      // No alarm or second ingest is allowed to repair the first request for this assertion.
      const after = await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json() as { bytes: number };
      expect(after.bytes).toBeLessThan(cap);
      await gitOk(['commit', '--allow-empty', '-m', 'safe after corrupt upload'], work);
      await gitOk(['push', 'origin', 'HEAD:refs/heads/recovered'], work);
      expect((await gitOk(['ls-remote', 'origin'], work)).stdout).toContain('refs/heads/recovered');
    } finally {
      await runtime.DATABASE.prepare("DELETE FROM platform_settings WHERE key='repositories.maxRepoBytes'").run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
  });
  it('retains failed GC work and reclaims it on the next alarm after a transient read failure', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'GC retry');
    const token = await mintToken(project, 'write');
    const before = await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json() as { objects: number };
    const { pack, commitOid } = await buildSeedPack({ projectName: 'Unreachable retry pack' });
    await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` }, body: buildReceivePackRequest(commitOid, 'main', pack) as BodyInit });
    await runtime.fetch(`/__test/alarm/${project.artifactsRepoId}/fail`, { method: 'POST' });
    const failed = await (await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`)).json() as { pending: string; alarm: number | null };
    expect(failed.pending).toBe('1'); expect(failed.alarm).not.toBeNull();
    await runtime.fetch(`/__test/alarm/${project.artifactsRepoId}/run`, { method: 'POST' });
    const done = await (await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`)).json();
    expect(done).toMatchObject({ pending: '0', alarm: null });
    const after = await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json() as { objects: number };
    expect(after.objects).toBe(before.objects);
    await runtime.fetch(`/__test/alarm/${project.artifactsRepoId}/run`, { method: 'POST' });
    expect(await (await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`)).json()).toMatchObject({ pending: '0', alarm: null });
  });
  it('transactionally deletes a populated repository and refuses later Git requests', async () => {
    const owner = await createEmailOnlyUser();
    const project = await createHostedProject(owner, 'Delete me');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    expect((await git(['ls-remote', remote])).code).toBe(0);
    expect((await runtime.fetch(`/__test/repository/${project.artifactsRepoId}`, { method: 'DELETE' })).status).toBe(200);
    const after = await git(['ls-remote', remote]);
    expect(after.code).not.toBe(0); expect(after.stderr).toContain('410');
    expect((await runtime.fetch(`/__test/repository/${project.artifactsRepoId}`, { method: 'DELETE' })).status).toBe(200);
  });
});

/**
 * Push connectivity admission: a ref may only move to an object whose whole closure is
 * present. Each scenario builds raw packs with the git CLI, sends them through the real
 * receive-pack route into the real SQLite store, and asserts on refs read back plus an
 * fsck of a fresh clone.
 */
describe('push connectivity admission (closure must be complete per command)', () => {
  const ZERO = '0'.repeat(40);

  function gitEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? '',
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };
  }

  /** A pack holding exactly `oids`, deliberately omitting anything they reference. */
  function packOf(cwd: string, oids: string[]): Buffer {
    const out = spawnSync('git', ['pack-objects', '--stdout'], {
      cwd,
      env: gitEnv(),
      input: `${oids.join('\n')}\n`,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (out.status !== 0) throw new Error(`pack-objects failed: ${out.stderr.toString()}`);
    return out.stdout;
  }

  async function rev(cwd: string, spec: string): Promise<string> {
    return (await gitOk(['rev-parse', spec], cwd)).stdout.trim();
  }

  /** Commit one new uniquely named file and return the commit and its root tree. */
  async function commitFile(cwd: string, name: string): Promise<{ commit: string; tree: string }> {
    await writeFile(join(cwd, name), `${name} ${randomBytes(8).toString('hex')}\n`);
    await gitOk(['add', name], cwd);
    await gitOk(['commit', '-m', name], cwd);
    return { commit: await rev(cwd, 'HEAD'), tree: await rev(cwd, 'HEAD^{tree}') };
  }

  async function receive(
    project: CreatedProject,
    token: string,
    commands: Array<[old: string, next: string, ref: string]>,
    pack?: Uint8Array
  ): Promise<string> {
    const packet = (line: string) => (Buffer.byteLength(line) + 4).toString(16).padStart(4, '0') + line;
    const lines = commands.map(([old, next, ref], i) =>
      packet(`${old} ${next} ${ref}${i === 0 ? '\0report-status' : ''}\n`)
    );
    const head = Buffer.from(lines.join('') + '0000');
    const body = pack ? Buffer.concat([head, Buffer.from(pack)]) : head;
    const res = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: body as unknown as BodyInit,
    });
    return res.text();
  }

  async function info(project: CreatedProject): Promise<{ objects: number }> {
    return (await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json()) as { objects: number };
  }

  async function gcState(project: CreatedProject): Promise<{ pending: string; alarm: number | null }> {
    const res = await runtime.fetch(`/__test/gc-state/${project.artifactsRepoId}`);
    return (await res.json()) as { pending: string; alarm: number | null };
  }

  /** Every blob and subtree under a commit's root tree. */
  async function treeObjects(cwd: string, commit: string): Promise<string[]> {
    return (await gitOk(['ls-tree', '-r', '-t', commit], cwd)).stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[2]!);
  }

  async function reachableCache(project: CreatedProject): Promise<boolean> {
    const info = (await (await runtime.fetch(`/__test/info/${project.artifactsRepoId}`)).json()) as {
      reachableCache: boolean;
    };
    return info.reachableCache;
  }

  async function assertCleanClone(remote: string): Promise<string> {
    const check = await freshDir('closure-check');
    await gitOk(['clone', remote, check]);
    expect((await git(['fsck', '--strict', '--connectivity-only'], check)).code).toBe(0);
    expect((await git(['fsck', '--strict'], check)).code).toBe(0);
    return check;
  }

  it('with a reachable cache, a failed first command does not vouch for a later command (Codex r4633317762)', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure cache attack');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('closure-cache');
    await gitOk(['clone', remote, work]); // a full clone persists the reachable cache
    expect(await reachableCache(project)).toBe(true);

    const { commit, tree } = await commitFile(work, 'attack.txt');
    // The pack carries the commit but not its tree. The first command's walk reaches the
    // missing tree and fails; the second command names that same tree directly. It is a tag,
    // since branches refuse non-commits before any walk, so only the walk decides it.
    const out = await receive(
      project,
      token,
      [
        [ZERO, commit, 'refs/heads/attack-commit'],
        [ZERO, tree, 'refs/tags/attack-tree'],
      ],
      packOf(work, [commit])
    );
    expect(out).toContain('ng refs/heads/attack-commit missing necessary objects');
    expect(out).toContain('ng refs/tags/attack-tree missing necessary objects');
    const refs = (await gitOk(['ls-remote', remote])).stdout;
    expect(refs).toContain('refs/heads/main');
    expect(refs).not.toContain('attack-commit');
    expect(refs).not.toContain('attack-tree');
    expect(await reachableCache(project)).toBe(true);
    await assertCleanClone(remote);
  });

  it('with a reachable cache, a valid multi-ref push whose closures overlap is accepted and extends the cache', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure cache control');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('closure-cache-ok');
    await gitOk(['clone', remote, work]);
    expect(await reachableCache(project)).toBe(true);

    const first = await commitFile(work, 'one.txt');
    const second = await commitFile(work, 'two.txt'); // child of `first`
    await gitOk(['branch', 'b-one', first.commit], work);
    await gitOk(['branch', 'b-two', second.commit], work);
    await gitOk(['push', 'origin', 'b-one', 'b-two', 'HEAD:refs/heads/main'], work);
    // A fast-forward with a valid prior cache extends it in place rather than invalidating.
    expect(await reachableCache(project)).toBe(true);
    const refs = (await gitOk(['ls-remote', remote])).stdout;
    expect(refs).toContain(`${first.commit}\trefs/heads/b-one`);
    expect(refs).toContain(`${second.commit}\trefs/heads/b-two`);
    // The next full clone is served from the extended cache, so a missing object fails fsck.
    const check = await assertCleanClone(remote);
    expect(await rev(check, 'origin/b-two')).toBe(second.commit);
  });

  it('without a reachable cache, a commit left by a rejected pack cannot be referenced later', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure stale pack');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('closure-stale');
    await gitOk(['init', '-q', '-b', 'main', work]);
    const orphan = await commitFile(work, 'orphan.txt'); // root commit, tree not sent
    expect(await reachableCache(project)).toBe(false);

    const first = await receive(project, token, [[ZERO, orphan.commit, 'refs/heads/stale']], packOf(work, [orphan.commit]));
    expect(first).toContain('ng refs/heads/stale missing necessary objects');
    // The rejected pack stays ingested until GC runs; it must not count as validated history.
    const child = await commitFile(work, 'child.txt');
    const childTreeObjects = (await gitOk(['ls-tree', '-r', '-t', child.commit], work)).stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[2]!)
      .filter((oid) => oid !== orphan.tree);
    const second = await receive(
      project,
      token,
      [
        [ZERO, orphan.commit, 'refs/heads/reuse-orphan'],
        [ZERO, child.commit, 'refs/heads/child-of-orphan'],
      ],
      packOf(work, [child.commit, child.tree, ...childTreeObjects])
    );
    expect(second).toContain('ng refs/heads/reuse-orphan missing necessary objects');
    expect(second).toContain('ng refs/heads/child-of-orphan missing necessary objects');
    const ref = await receive(project, token, [[ZERO, orphan.commit, 'refs/heads/ref-only']]);
    expect(ref).toContain('ng refs/heads/ref-only missing necessary objects');
    const refs = (await gitOk(['ls-remote', remote])).stdout;
    expect(refs).toContain('refs/heads/main');
    expect(refs).not.toMatch(/stale|reuse-orphan|child-of-orphan|ref-only/);
    expect(await reachableCache(project)).toBe(false);
    await assertCleanClone(remote);
  });

  it('with a reachable cache, one failing command does not block or pollute a valid sibling', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure mixed push');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('closure-mixed');
    await gitOk(['clone', remote, work]);
    expect(await reachableCache(project)).toBe(true);
    const base = await rev(work, 'HEAD');
    const valid = await commitFile(work, 'valid.txt');
    await gitOk(['checkout', '-q', '--detach', base], work);
    const broken = await commitFile(work, 'broken.txt');
    const validObjects = (await gitOk(['rev-list', '--objects', valid.commit, `^${base}`], work)).stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ')[0]!);
    const out = await receive(
      project,
      token,
      [
        [ZERO, broken.commit, 'refs/heads/broken'],
        [ZERO, valid.commit, 'refs/heads/valid'],
      ],
      packOf(work, [broken.commit, ...validObjects])
    );
    expect(out).toContain('ng refs/heads/broken missing necessary objects');
    expect(out).toContain('ok refs/heads/valid');
    expect(await reachableCache(project)).toBe(true);
    const check = await assertCleanClone(remote);
    expect(await rev(check, 'origin/valid')).toBe(valid.commit);
    expect((await gitOk(['ls-remote', remote])).stdout).not.toContain('refs/heads/broken');
  });

  it('refuses a commit that does not parse for that command only, and queues its pack for GC', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure malformed');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect(await gcState(project)).toMatchObject({ pending: '0', alarm: null });
    const work = await freshDir('closure-malformed');
    await gitOk(['init', '-q', '-b', 'main', work]);
    const made = spawnSync('git', ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], {
      cwd: work,
      env: gitEnv(),
      input: `author ${'Test <test@example.com> 0 +0000'}\ncommitter Test <test@example.com> 0 +0000\n\nno tree header\n`,
    });
    expect(made.status).toBe(0);
    const malformed = made.stdout.toString().trim();
    const ordinary = await commitFile(work, 'ordinary.txt');
    const out = await receive(
      project,
      token,
      [
        [ZERO, malformed, 'refs/heads/malformed'],
        [ZERO, ordinary.commit, 'refs/heads/ordinary'],
      ],
      packOf(work, [malformed, ordinary.commit, ordinary.tree, ...(await treeObjects(work, ordinary.commit))])
    );
    expect(out).toContain('ng refs/heads/malformed missing necessary objects');
    expect(out).toContain('ok refs/heads/ordinary');
    expect((await gcState(project)).pending).toBe('1');
    await assertCleanClone(remote);
  });

  it('refuses a push whose object SHA-1DC flags as a collision attack, before any ref', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Collision screen');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('collision');
    await gitOk(['clone', remote, work]);
    await commitFile(work, 'collide.txt');
    const blob = await rev(work, 'HEAD:collide.txt');
    // The detector's verdict for this one object is forced (see flagCollisionOnce): a real git
    // object cannot carry the published SHAttered blocks.
    await runtime.fetch(`/__test/flag-collision/${project.artifactsRepoId}/${blob}`, { method: 'POST' });
    const refused = await git(['push', 'origin', 'HEAD:refs/heads/collide'], work);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`object ${blob.slice(0, 12)} triggered SHA-1 collision detection`);
    expect((await gitOk(['ls-remote', 'origin'], work)).stdout).not.toContain('refs/heads/collide');
    expect((await gcState(project)).pending).toBe('1');
    // Control: the same push, unflagged, is accepted, so the refusal came from the detector alone.
    await gitOk(['push', 'origin', 'HEAD:refs/heads/collide'], work);
    expect((await gitOk(['ls-remote', 'origin'], work)).stdout).toContain('refs/heads/collide');

    // A delta-resolved object is screened too: git sends this edit of a large file as a thin-pack
    // delta against the blob the server already has.
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    await writeFile(join(work, 'big.txt'), `${big}\n`);
    await gitOk(['add', 'big.txt'], work);
    await gitOk(['commit', '-m', 'big'], work);
    await gitOk(['push', 'origin', 'HEAD:refs/heads/collide'], work);
    await writeFile(join(work, 'big.txt'), `${big}\nappended\n`);
    await gitOk(['commit', '-am', 'edit'], work);
    const edited = await rev(work, 'HEAD:big.txt');
    await runtime.fetch(`/__test/flag-collision/${project.artifactsRepoId}/${edited}`, { method: 'POST' });
    const deltaRefused = await git(['push', 'origin', 'HEAD:refs/heads/collide-delta'], work);
    expect(deltaRefused.code).not.toBe(0);
    expect(deltaRefused.stderr).toContain(`object ${edited.slice(0, 12)} triggered SHA-1 collision detection`);
    expect((await gitOk(['ls-remote', 'origin'], work)).stdout).not.toContain('refs/heads/collide-delta');
  });

  it('queues GC for an ingested pack when validation fails before any ref decision', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure validate fault');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect(await gcState(project)).toMatchObject({ pending: '0', alarm: null });
    const before = await info(project);
    const work = await freshDir('closure-fault');
    await gitOk(['init', '-q', '-b', 'main', work]);
    const root = await commitFile(work, 'fault.txt');
    // The next read of this commit throws: ingest has stored the pack, the walk then faults.
    await runtime.fetch(`/__test/fail-read/${project.artifactsRepoId}/${root.commit}`, { method: 'POST' });
    const res = await runtime.fetch(`/git/${project.artifactsRepoId}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
        'content-type': 'application/x-git-receive-pack-request',
      },
      body: buildReceivePackRequest(
        root.commit,
        'fault',
        packOf(work, [root.commit, root.tree, ...(await treeObjects(work, root.commit))])
      ) as BodyInit,
    });
    const text = await res.text();
    // The fault surfaced from validation, not from ingest (which would answer "unpack ...").
    expect(res.status).toBe(500);
    expect(text).not.toContain('unpack');
    expect((await info(project)).objects).toBeGreaterThan(before.objects);
    const queued = await gcState(project);
    expect(queued.pending).toBe('1');
    expect(queued.alarm).not.toBeNull();
    expect((await gitOk(['ls-remote', remote])).stdout).not.toContain('refs/heads/fault');
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect((await info(project)).objects).toBe(before.objects);
  });

  it('keeps pushes and deletions working however large the existing ref tips are', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Large tips');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('large-tips');
    await gitOk(['clone', remote, work]);
    const base = await rev(work, 'HEAD');
    // Each tip is a commit with a 5 MiB message (a few KB compressed). Objects over a quarter of
    // the 16 MiB serving cache are never cached, so every read inflates it again. A push costs
    // about 10 MiB of a 14 MiB decompression budget; reading the existing tips on each push
    // would exceed it from the second tip on.
    const message = join(work, '..', `msg-${randomBytes(4).toString('hex')}`);
    await writeFile(message, 'a'.repeat(5 * 1024 * 1024));
    const setting = "INSERT INTO platform_settings (key,value,updated_at) VALUES ('repositories.maxInflatedBytes',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
    await runtime.DATABASE.prepare(setting).bind(JSON.stringify(14 * 1024 * 1024), Date.now()).run();
    await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    try {
      for (let i = 0; i < 4; i++) {
        await gitOk(['checkout', '-q', '--detach', base], work);
        await writeFile(join(work, `big-${i}.txt`), `${i}\n`);
        await gitOk(['add', '.'], work);
        await gitOk(['commit', '-q', '-F', message], work);
        await gitOk(['push', 'origin', `HEAD:refs/heads/big-${i}`], work);
      }
      const small = await commitFile(work, 'small.txt');
      await gitOk(['push', 'origin', 'HEAD:refs/heads/small'], work);
      await gitOk(['push', 'origin', '--delete', 'big-0'], work);
      const refs = (await gitOk(['ls-remote', remote])).stdout;
      expect(refs).toContain(`${small.commit}\trefs/heads/small`);
      expect(refs).toContain('refs/heads/big-3');
      expect(refs).not.toContain('refs/heads/big-0\n');
    } finally {
      await runtime.DATABASE.prepare("DELETE FROM platform_settings WHERE key='repositories.maxInflatedBytes'").run();
      await runtime.fetch('/__test/invalidate-settings', { method: 'POST' });
    }
  });

  it('refuses objects of the wrong type at an edge or on a branch, and keeps clones working', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Edge types');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('edge-types');
    await gitOk(['init', '-q', '-b', 'main', work]);
    const plain = await commitFile(work, 'plain.txt');
    const blob = (await gitOk(['rev-parse', `${plain.commit}:plain.txt`], work)).stdout.trim();
    const made = spawnSync('git', ['hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], {
      cwd: work,
      env: gitEnv(),
      input: `tree ${blob}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\nblob as tree\n`,
    });
    expect(made.status).toBe(0);
    const evil = made.stdout.toString().trim();
    const out = await receive(
      project,
      token,
      [
        [ZERO, evil, 'refs/heads/evil'],
        [ZERO, plain.tree, 'refs/heads/tree-branch'],
        [ZERO, plain.tree, 'refs/tags/tree-tag'],
      ],
      packOf(work, [evil, blob, plain.tree])
    );
    expect(out).toContain('ng refs/heads/evil missing necessary objects');
    expect(out).toContain('ng refs/heads/tree-branch trying to write non-commit object to branch');
    expect(out).toContain('ok refs/tags/tree-tag');
    await assertCleanClone(remote);
  });

  it('refuses objects git cannot read (header order, tag headers, tree modes) and keeps clones working', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Object shapes');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('object-shapes');
    await gitOk(['init', '-q', '-b', 'main', work]);
    const plain = await commitFile(work, 'plain.txt');
    const blob = (await gitOk(['rev-parse', `${plain.commit}:plain.txt`], work)).stdout.trim();
    const literal = (type: string, input: Buffer | string) => {
      const out = spawnSync('git', ['hash-object', '-t', type, '--literally', '-w', '--stdin'], { cwd: work, env: gitEnv(), input });
      expect(out.status).toBe(0);
      return out.stdout.toString().trim();
    };
    const sig = 'Test <test@example.com> 0 +0000';
    const authorFirst = literal('commit', `author ${sig}\ntree ${plain.tree}\ncommitter ${sig}\n\nauthor first\n`);
    const leading = literal('commit', ` junk\ntree ${plain.tree}\nauthor ${sig}\ncommitter ${sig}\n\nleading continuation\n`);
    const typeFirstTag = literal('tag', `type commit\nobject ${plain.commit}\ntag odd\ntagger ${sig}\n\nodd\n`);
    const badModeTree = literal('tree', Buffer.concat([Buffer.from('8 f\0'), Buffer.from(blob, 'hex')]));
    const badModeCommit = literal('commit', `tree ${badModeTree}\nauthor ${sig}\ncommitter ${sig}\n\nbad mode\n`);
    const out = await receive(
      project,
      token,
      [
        [ZERO, authorFirst, 'refs/heads/author-first'],
        [ZERO, leading, 'refs/heads/leading'],
        [ZERO, typeFirstTag, 'refs/tags/type-first'],
        [ZERO, badModeCommit, 'refs/heads/bad-mode'],
        [ZERO, plain.commit, 'refs/heads/plain'],
      ],
      packOf(work, [authorFirst, leading, typeFirstTag, badModeTree, badModeCommit, plain.commit, plain.tree, blob])
    );
    expect(out).toContain('ng refs/heads/author-first missing necessary objects');
    expect(out).toContain('ng refs/heads/leading missing necessary objects');
    expect(out).toContain('ng refs/tags/type-first missing necessary objects');
    expect(out).toContain('ng refs/heads/bad-mode missing necessary objects');
    expect(out).toContain('ok refs/heads/plain');
    const check = await assertCleanClone(remote);
    expect(await rev(check, 'origin/plain')).toBe(plain.commit);
  });

  it('treats deleting a missing ref as a no-op that queues no GC, and refuses D/F ref conflicts', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Ref no-ops');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    await runtime.fetch(`/__test/gc/${project.artifactsRepoId}`, { method: 'POST' });
    expect(await gcState(project)).toMatchObject({ pending: '0', alarm: null });
    const missing = await receive(project, token, [[ZERO, ZERO, 'refs/heads/never-existed']]);
    expect(missing).toContain('ok refs/heads/never-existed');
    expect(await gcState(project)).toMatchObject({ pending: '0', alarm: null });

    const main = (await gitOk(['ls-remote', remote, 'refs/heads/main'])).stdout.split(/\s+/)[0]!;
    expect(await receive(project, token, [[ZERO, main, 'refs/heads/df']])).toContain('ok refs/heads/df');
    const nested = await receive(project, token, [
      [ZERO, main, 'refs/heads/df/x'],
      [ZERO, main, 'refs/heads/dfx'],
    ]);
    expect(nested).toContain('ng refs/heads/df/x ref name conflicts with an existing ref');
    expect(nested).toContain('ok refs/heads/dfx');
    // A real deletion is the control: it changes refs and queues GC.
    expect(await receive(project, token, [[main, ZERO, 'refs/heads/df']])).toContain('ok refs/heads/df');
    expect((await gcState(project)).pending).toBe('1');
    await assertCleanClone(remote);
  });

  it('without a reachable cache, a valid push from a shallow clone is accepted', async () => {
    const project = await createHostedProject(await createEmailOnlyUser(), 'Closure shallow control');
    const token = await mintToken(project, 'write');
    const remote = localRemote(project.repository, token);
    const work = await freshDir('closure-shallow');
    await gitOk(['clone', '--depth', '1', remote, work]); // not a full clone: no cache
    expect(await reachableCache(project)).toBe(false);
    const next = await commitFile(work, 'shallow.txt');
    await gitOk(['push', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/shallow-copy'], work);
    const refs = (await gitOk(['ls-remote', remote])).stdout;
    expect(refs).toContain(`${next.commit}\trefs/heads/main`);
    expect(refs).toContain(`${next.commit}\trefs/heads/shallow-copy`);
    await assertCleanClone(remote);
  });
});
