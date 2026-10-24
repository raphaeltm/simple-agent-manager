/**
 * Behavioral tests for the Artifacts README seed.
 *
 * The pack + receive-pack request are validated against a REAL `git
 * receive-pack --stateless-rpc` — the exact server-side mode Git's http-backend
 * uses for smart-HTTP pushes. This proves the generated packfile and pkt-line
 * framing are byte-compatible with Git, not merely self-consistent.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReadmeContent,
  buildReceivePackRequest,
  buildSeedPack,
  parseReceivePackResult,
  seedArtifactsReadme,
} from '../../src/services/artifacts/seed-readme';

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('buildReadmeContent', () => {
  it('includes the project name as an H1', () => {
    const readme = buildReadmeContent('My Cool Project');
    expect(readme).toContain('# My Cool Project');
  });

  it('includes the description when provided', () => {
    const readme = buildReadmeContent('P', 'A serverless todo app');
    expect(readme).toContain('A serverless todo app');
  });

  it('omits the description block when absent or blank', () => {
    const readme = buildReadmeContent('P', '   ');
    // Only the H1 heading followed by a blank line, then the SAM boilerplate.
    expect(readme.startsWith('# P\n\nThis repository is hosted by')).toBe(true);
  });

  it('points agents at the core SAM MCP tools', () => {
    const readme = buildReadmeContent('P');
    for (const tool of [
      'get_instructions',
      'dispatch_task',
      'update_task_status',
      'search_knowledge',
      'create_idea',
    ]) {
      expect(readme).toContain(tool);
    }
  });

  it('tells agents not to use GitHub-specific tooling', () => {
    const readme = buildReadmeContent('P');
    expect(readme).toContain('`gh` CLI');
  });
});

describe('parseReceivePackResult', () => {
  it('treats "unpack ok" + "ok <ref>" as success', () => {
    expect(parseReceivePackResult('000eunpack ok\n0019ok refs/heads/main\n0000').ok).toBe(true);
  });

  it('treats "ng <ref>" as failure', () => {
    const r = parseReceivePackResult('000eunpack ok\n0028ng refs/heads/main permission denied\n0000');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('ng refs/heads/main');
  });

  it('treats an empty body as failure', () => {
    expect(parseReceivePackResult('').ok).toBe(false);
  });
});

const hasGit = gitAvailable();

describe.runIf(hasGit)('buildSeedPack against real git receive-pack', () => {
  let dir: string;
  let bare: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sam-seed-'));
    bare = join(dir, 'repo.git');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare], { stdio: 'ignore' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a pack + command that git accepts, creating the branch with the README', async () => {
    const { pack, commitOid } = await buildSeedPack({
      projectName: 'Seed Test Project',
      description: 'Validated against real git',
      now: new Date('2026-07-02T00:00:00Z'),
    });
    const request = buildReceivePackRequest(commitOid, 'main', pack);

    // Feed the exact HTTP receive-pack body to git's stateless-rpc server mode.
    const requestFile = join(dir, 'request.bin');
    writeFileSync(requestFile, pack.length ? Buffer.from(request) : Buffer.alloc(0));
    const result = execFileSync('sh', [
      '-c',
      `git receive-pack --stateless-rpc "${bare}" < "${requestFile}"`,
    ]);
    expect(parseReceivePackResult(result.toString('latin1')).ok).toBe(true);

    // The ref now exists and points at our commit.
    const ref = execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'])
      .toString()
      .trim();
    expect(ref).toBe(commitOid);

    // The README content round-trips exactly.
    const readme = execFileSync('git', ['-C', bare, 'cat-file', '-p', 'main:README.md']).toString();
    expect(readme).toBe(buildReadmeContent('Seed Test Project', 'Validated against real git'));

    // The commit message and single-file tree are as expected.
    const tree = execFileSync('git', ['-C', bare, 'ls-tree', '--name-only', 'main']).toString().trim();
    expect(tree).toBe('README.md');
  });

  it('creates a non-main default branch when requested', async () => {
    const { pack, commitOid } = await buildSeedPack({ projectName: 'Trunk Project' });
    const request = buildReceivePackRequest(commitOid, 'trunk', pack);
    const requestFile = join(dir, 'request.bin');
    writeFileSync(requestFile, Buffer.from(request));
    execFileSync('sh', ['-c', `git receive-pack --stateless-rpc "${bare}" < "${requestFile}"`]);

    const ref = execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/trunk']).toString().trim();
    expect(ref).toBe(commitOid);
  });
});

describe.runIf(hasGit)('seedArtifactsReadme HTTP contract', () => {
  it('POSTs to /git-receive-pack with Basic x:<token> auth and the receive-pack body', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sam-seed-http-'));
    const bare = join(dir, 'repo.git');
    execFileSync('git', ['init', '--bare', '--initial-branch', 'main', bare], { stdio: 'ignore' });

    let capturedUrl = '';
    let capturedAuth = '';
    let capturedContentType = '';

    // Mock fetch: run the posted body through real git receive-pack and return
    // the actual git result, exercising the true protocol contract.
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      capturedContentType = (init.headers as Record<string, string>)['Content-Type'];
      const requestFile = join(dir, 'http-request.bin');
      writeFileSync(requestFile, Buffer.from(init.body as Uint8Array));
      const out = execFileSync('sh', [
        '-c',
        `git receive-pack --stateless-rpc "${bare}" < "${requestFile}"`,
      ]);
      return new Response(out.toString('latin1'), { status: 200 });
    }) as unknown as typeof fetch;

    await seedArtifactsReadme({
      remote: 'https://acct.artifacts.cloudflare.net/git/default/my-repo.git',
      token: 'art_v1_secret',
      branch: 'main',
      projectName: 'HTTP Project',
      description: 'via seedArtifactsReadme',
      fetchImpl,
    });

    expect(capturedUrl).toBe(
      'https://acct.artifacts.cloudflare.net/git/default/my-repo.git/git-receive-pack'
    );
    expect(capturedAuth).toBe(`Basic ${Buffer.from('x:art_v1_secret').toString('base64')}`);
    expect(capturedContentType).toBe('application/x-git-receive-pack-request');

    const readme = execFileSync('git', ['-C', bare, 'cat-file', '-p', 'main:README.md']).toString();
    expect(readme).toContain('# HTTP Project');

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the server returns a non-2xx status', async () => {
    const fetchImpl = (async () =>
      new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    await expect(
      seedArtifactsReadme({
        remote: 'https://acct.artifacts.cloudflare.net/git/default/my-repo.git',
        token: 't',
        branch: 'main',
        projectName: 'P',
        fetchImpl,
      })
    ).rejects.toThrow(/HTTP 403/);
  });

  it('throws when the ref update is rejected (ng)', async () => {
    const fetchImpl = (async () =>
      new Response('000eunpack ok\n0028ng refs/heads/main permission denied\n0000', {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      seedArtifactsReadme({
        remote: 'https://acct.artifacts.cloudflare.net/git/default/my-repo.git',
        token: 't',
        branch: 'main',
        projectName: 'P',
        fetchImpl,
      })
    ).rejects.toThrow(/ref update failed/);
  });
});
