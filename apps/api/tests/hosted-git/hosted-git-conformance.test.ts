/**
 * Conformance of the SAM-hosted git server with a real git client.
 *
 * Everything below drives the stock `git` CLI over HTTP against the HostedGitRepo Durable Object
 * running in Miniflare, through the same authenticated route production mounts at
 * `https://api.<BASE_DOMAIN>/git/<repo>.git`. Repositories are created through the real
 * project-create route (artifacts provider, an email-only user with no GitHub link), which seeds
 * the README in-process; workspace credentials come from the real POST /workspaces/:id/git-token.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_HOSTED_GIT_MAX_PUSH_BYTES,
  DEFAULT_HOSTED_GIT_MAX_REPO_OBJECTS,
} from '../../src/services/hosted-git/limits';
import {
  HOSTED_GIT_TEST_BASE_DOMAIN,
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
    throw new Error(`git ${args.join(' ')} failed (${result.code}):\n${result.stderr}`);
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

describe('import from a public git URL', () => {
  it('imports the source default branch and history into a new hosted project', async () => {
    const owner = await createEmailOnlyUser();
    const source = await createHostedProject(owner, 'Import Source');
    const token = await mintToken(source, 'write');
    const work = await freshDir('import-src');
    await gitOk(['clone', localRemote(source.repository, token), work]);
    await writeFile(join(work, 'imported.txt'), 'from the source\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'source commit'], work);
    await gitOk(['push', 'origin', 'HEAD'], work);
    const sourceHead = (await gitOk(['rev-parse', 'HEAD'], work)).stdout.trim();
    fakeForge.set('source', {
      repo: source.artifactsRepoId,
      token: await mintToken(source, 'read'),
    });

    const res = await runtime.fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user-id': owner },
      body: JSON.stringify({
        name: 'Imported',
        repoProvider: 'artifacts',
        importUrl: 'https://github.com/sam-test/source.git',
      }),
    });
    const body = (await res.json()) as { id: string };
    expect(res.status, JSON.stringify(body)).toBe(201);
    const imported = await runtime.DATABASE.prepare(
      `SELECT repository, artifacts_repo_id AS artifactsRepoId FROM projects WHERE id = ?`
    )
      .bind(body.id)
      .first<{ repository: string; artifactsRepoId: string }>();
    const check = await freshDir('imported');
    await gitOk([
      'clone',
      localRemote(
        imported!.repository,
        await mintToken({ artifactsRepoId: imported!.artifactsRepoId, ownerId: owner }, 'read')
      ),
      check,
    ]);
    expect((await gitOk(['rev-parse', 'HEAD'], check)).stdout.trim()).toBe(sourceHead);
    expect(await readFile(join(check, 'imported.txt'), 'utf8')).toBe('from the source\n');
  });

  it('refuses import URLs outside the public-forge allowlist without fetching them', async () => {
    const owner = await createEmailOnlyUser();
    for (const importUrl of [
      'http://github.com/sam-test/source.git',
      'https://127.0.0.1:7001/x.git',
      'https://user:pw@github.com/sam-test/source.git',
      'https://example.com/x.git',
    ]) {
      const res = await runtime.fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-user-id': owner },
        body: JSON.stringify({
          name: `bad-${Math.random()}`,
          repoProvider: 'artifacts',
          importUrl,
        }),
      });
      expect(res.status, importUrl).toBe(400);
    }
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
    const body = (await res.json()) as { token: string; cloneUrl: string; host: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.cloneUrl).toBe(project.repository);
    const work = await freshDir('member');
    await gitOk(['clone', localRemote(body.cloneUrl, body.token), work]);
    await writeFile(join(work, 'human.txt'), 'from a laptop\n');
    await gitOk(['add', '.'], work);
    await gitOk(['commit', '-m', 'human'], work);
    await gitOk(['push', 'origin', 'HEAD'], work);

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
      host?: string;
      username?: string;
    };
    expect(res.status, JSON.stringify(body)).toBe(200);
    // What the VM agent's credential helper needs for a host it does not know by name.
    expect(body.cloneUrl).toBe(project.repository);
    expect(body.host).toBe(`api.${HOSTED_GIT_TEST_BASE_DOMAIN}`);
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
