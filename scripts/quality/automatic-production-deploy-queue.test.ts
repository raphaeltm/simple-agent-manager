/**
 * Drives the real automatic production gate (`validateAutomaticProductionDispatch`)
 * through the `deploy-production` queue sequences that overlapping main CI runs create.
 *
 * GitHub keeps one running and one pending run per concurrency group; a newly queued run
 * replaces the pending one. `DeployQueue` models exactly that, and a stubbed GitHub API
 * serves the main tip, CI runs and production deployment markers from shared state, so
 * every decision comes from the validator itself.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateAutomaticProductionDispatch } from '../deploy/validate-production-dispatch.js';

const repository = 'owner/repo';
const token = 'ghs_fake_token_value_for_test_only';
const W = '1111111111111111111111111111111111111111';
const X = '2222222222222222222222222222222222222222';
const Y = '3333333333333333333333333333333333333333';

type CiState = 'in_progress' | 'success' | 'failure';

interface GithubState {
  mainTip: string;
  ci: Map<string, CiState>;
  /** Newest first, as the GitHub deployments API returns them. */
  deployments: { id: number; sha: string; payload: unknown; state: string }[];
  /** Paths that return HTTP 500, to prove fail-closed behaviour. */
  failing: string[];
  /** Extra runs returned for every CI query, for API-misbehaviour controls. */
  extraRuns: unknown[];
}

let state: GithubState;
let dir: string;

function ciRun(sha: string, ciState: CiState, id: number) {
  return {
    id,
    name: 'CI',
    head_sha: sha,
    head_branch: 'main',
    head_repository: { full_name: repository },
    event: 'push',
    status: ciState === 'in_progress' ? 'in_progress' : 'completed',
    conclusion: ciState === 'in_progress' ? null : ciState,
    html_url: `https://github.test/runs/${id}`,
  };
}

function recordDeployment(
  sha: string,
  payload: unknown = { workflow: 'deploy.yml', dry_run: false }
) {
  state.deployments.unshift({ id: state.deployments.length + 1, sha, payload, state: 'success' });
}

function stubGithub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (state.failing.some((path) => url.pathname.includes(path))) {
        return new Response('boom', { status: 500 });
      }
      if (url.pathname === `/repos/${repository}/git/ref/heads/main`) {
        return Response.json({ object: { sha: state.mainTip } });
      }
      if (url.pathname === `/repos/${repository}/actions/workflows/ci.yml/runs`) {
        const sha = url.searchParams.get('head_sha') ?? '';
        const ciState = state.ci.get(sha);
        const runs = ciState ? [ciRun(sha, ciState, 100)] : [];
        return Response.json({ workflow_runs: [...runs, ...state.extraRuns] });
      }
      if (url.pathname === `/repos/${repository}/deployments`) {
        expect(url.searchParams.get('environment')).toBe('production');
        return Response.json(
          state.deployments.map(({ id, sha, payload }) => ({ id, sha, payload }))
        );
      }
      const statusMatch = url.pathname.match(/\/deployments\/(\d+)\/statuses$/);
      if (statusMatch) {
        const deployment = state.deployments.find((d) => d.id === Number(statusMatch[1]));
        return Response.json(deployment ? [{ state: deployment.state }] : []);
      }
      return new Response('unexpected test URL', { status: 500 });
    })
  );
}

/** Runs the real gate as the `validate-automatic-dispatch` job would, returning deploy_sha. */
async function runGate(triggeringSha: string): Promise<string | undefined> {
  const output = join(dir, `output-${Math.random()}`);
  writeFileSync(output, '');
  await validateAutomaticProductionDispatch({
    githubEventName: 'workflow_run',
    githubRepository: repository,
    githubToken: token,
    triggeringCommitSha: triggeringSha,
    githubOutput: output,
  });
  const match = readFileSync(output, 'utf8').match(/^deploy_sha=(.*)$/m);
  return match?.[1] || undefined;
}

/** GitHub's single-running, single-pending concurrency group for `deploy-production`. */
class DeployQueue {
  running: { trigger: string; deploySha?: string } | null = null;
  pending: string | null = null;
  readonly deployed: string[] = [];

  /** A main CI run for `sha` completed successfully, queuing a Deploy Production run. */
  async ciSucceeded(sha: string): Promise<void> {
    state.ci.set(sha, 'success');
    if (this.running) {
      this.pending = sha; // replaces any pending run
    } else {
      await this.start(sha);
    }
  }

  /** The running deploy finishes; the mark job records it and the pending run starts. */
  async finishRunning(): Promise<void> {
    const finished = this.running;
    if (!finished) throw new Error('nothing running');
    if (finished.deploySha) {
      this.deployed.push(finished.deploySha);
      recordDeployment(finished.deploySha);
    }
    this.running = null;
    const next = this.pending;
    this.pending = null;
    if (next) await this.start(next);
  }

  async drain(): Promise<void> {
    while (this.running) await this.finishRunning();
  }

  private async start(trigger: string): Promise<void> {
    // The deploy job deploys exactly what the gate selected, and is skipped when empty.
    const deploySha = await runGate(trigger);
    if (deploySha) {
      // Invariant: anything deployed is the main tip with its own successful CI run.
      expect(deploySha).toBe(state.mainTip);
      expect(state.ci.get(deploySha)).toBe('success');
    }
    this.running = { trigger, deploySha };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-auto-deploy-'));
  state = { mainTip: W, ci: new Map(), deployments: [], failing: [], extraRuns: [] };
  stubGithub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('automatic production deploy queue: out-of-order main CI', () => {
  it('deploys the tip when an older commit’s run replaced the tip’s pending run', async () => {
    const queue = new DeployQueue();
    await queue.ciSucceeded(W); // W deploying
    expect(queue.running?.deploySha).toBe(W);

    state.mainTip = Y; // X then Y merged; Y's CI finishes first
    state.ci.set(X, 'in_progress');
    await queue.ciSucceeded(Y); // Y's deploy run goes pending
    await queue.ciSucceeded(X); // X's run replaces Y's pending run
    expect(queue.pending).toBe(X);

    await queue.drain();

    // Before the fix X's run failed closed and Y stayed undeployed.
    expect(queue.deployed).toEqual([W, Y]);
  });

  it('ends without deploying while the tip’s CI is pending, then deploys it on its own completion', async () => {
    const queue = new DeployQueue();
    recordDeployment(W);
    state.mainTip = Y;
    state.ci.set(Y, 'in_progress');

    await queue.ciSucceeded(X); // older commit finishes first
    expect(queue.running?.deploySha).toBeUndefined();
    await queue.drain();
    expect(queue.deployed).toEqual([]);

    await queue.ciSucceeded(Y);
    await queue.drain();
    expect(queue.deployed).toEqual([Y]);
  });

  it('does not deploy a tip that is already deployed when an older CI finishes late', async () => {
    const queue = new DeployQueue();
    state.mainTip = Y;
    state.ci.set(X, 'in_progress');

    await queue.ciSucceeded(Y);
    await queue.drain();
    expect(queue.deployed).toEqual([Y]);

    await queue.ciSucceeded(X);
    expect(queue.running?.deploySha).toBeUndefined();
    await queue.drain();
    expect(queue.deployed).toEqual([Y]);
  });

  it('does not deploy the tip twice when its run was pending behind its own deploy', async () => {
    const queue = new DeployQueue();
    state.mainTip = Y;
    await queue.ciSucceeded(Y); // Y deploying
    await queue.ciSucceeded(X); // X's run pending; starts after Y's marker is recorded
    await queue.drain();
    expect(queue.deployed).toEqual([Y]);
  });

  it('never deploys anything when the tip’s CI failed (control: a green older commit is not deployed)', async () => {
    const queue = new DeployQueue();
    recordDeployment(W);
    state.mainTip = Y;
    state.ci.set(Y, 'failure');

    await queue.ciSucceeded(X); // X is green, but X is not the tip
    await queue.drain();

    expect(queue.deployed).toEqual([]);
  });
});

describe('automatic production gate decisions', () => {
  it('deploys only the tip even when the CI API also returns green runs for other SHAs', async () => {
    state.mainTip = Y;
    state.ci.set(Y, 'in_progress');
    state.extraRuns = [ciRun(X, 'success', 7)];

    await expect(runGate(X)).resolves.toBeUndefined();
  });

  it('rejects tip CI runs that are not trusted main pushes in this repository', async () => {
    state.mainTip = Y;
    state.extraRuns = [
      { ...ciRun(Y, 'success', 8), event: 'pull_request' },
      { ...ciRun(Y, 'success', 9), head_repository: { full_name: 'attacker/repo' } },
      { ...ciRun(Y, 'success', 10), head_branch: 'feature' },
      { ...ciRun(Y, 'success', 11), name: 'Other' },
    ];

    await expect(runGate(X)).resolves.toBeUndefined();
  });

  it('ignores dry-run and foreign deployments when deciding whether the tip is deployed', async () => {
    state.mainTip = Y;
    state.ci.set(Y, 'success');
    recordDeployment(W);
    recordDeployment(Y, { workflow: 'deploy.yml', dry_run: true });
    recordDeployment(Y, {});
    recordDeployment(Y, 'deploy.yml');

    await expect(runGate(X)).resolves.toBe(Y);
  });

  it('ignores a tip marker whose latest status is not success', async () => {
    state.mainTip = Y;
    state.ci.set(Y, 'success');
    recordDeployment(W);
    recordDeployment(Y);
    state.deployments[0].state = 'failure';

    await expect(runGate(Y)).resolves.toBe(Y);
  });

  it('reports the decision', async () => {
    state.mainTip = Y;
    state.ci.set(Y, 'success');

    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_run',
        githubRepository: repository,
        githubToken: token,
        triggeringCommitSha: X,
      })
    ).resolves.toEqual({ sha: Y, mainTip: Y, triggeringSha: X, decision: 'deploy' });

    state.ci.set(Y, 'failure');
    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_run',
        githubRepository: repository,
        githubToken: token,
        triggeringCommitSha: X,
      })
    ).resolves.toEqual({ mainTip: Y, triggeringSha: X, decision: 'skip-tip-ci-not-successful' });
  });

  it.each([
    ['main ref', '/git/ref/heads/main'],
    ['CI runs', '/actions/workflows/ci.yml/runs'],
    ['deployments', '/deployments'],
    ['deployment statuses', '/statuses'],
  ])('fails closed when the %s API errors', async (_name, path) => {
    state.mainTip = Y;
    state.ci.set(Y, 'success');
    recordDeployment(W);
    state.failing = [path];
    const output = join(dir, 'output');
    writeFileSync(output, '');

    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_run',
        githubRepository: repository,
        githubToken: token,
        triggeringCommitSha: X,
        githubOutput: output,
      })
    ).rejects.toThrow(/HTTP 500.*failed closed/);
    expect(readFileSync(output, 'utf8')).not.toContain('deploy_sha=');
  });

  it('fails closed on a malformed response or triggering SHA', async () => {
    state.mainTip = Y;
    state.extraRuns = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) =>
        String(input).includes('/git/ref/heads/main')
          ? Response.json({ object: { sha: Y } })
          : Response.json({ message: 'not a list' })
      )
    );
    await expect(runGate(X)).rejects.toThrow(/failed closed/);
    await expect(runGate('main')).rejects.toThrow(/exact 40-character commit SHA/);
  });

  it('follows deployment pagination to find the marker, and rejects untrusted next pages', async () => {
    state.mainTip = Y;
    state.ci.set(Y, 'success');
    let nextUrl = `https://api.github.com/repos/${repository}/deployments?environment=production&page=2`;
    const ciAndRef = (url: URL) =>
      url.pathname.endsWith('/git/ref/heads/main')
        ? Response.json({ object: { sha: Y } })
        : Response.json({ workflow_runs: [ciRun(Y, 'success', 1)] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/statuses')) return Response.json([{ state: 'success' }]);
        if (url.pathname.endsWith('/deployments')) {
          if (url.searchParams.get('page') === '2') {
            return Response.json([
              { id: 2, sha: Y, payload: { workflow: 'deploy.yml', dry_run: false } },
            ]);
          }
          return Response.json([{ id: 1, sha: Y, payload: {} }], {
            headers: { link: `<${nextUrl}>; rel="next"` },
          });
        }
        return ciAndRef(url);
      })
    );

    // The tip's marker is only on page 2, so finding it means no redeploy.
    await expect(runGate(X)).resolves.toBeUndefined();

    nextUrl = 'https://attacker.test/deployments?page=2';
    await expect(runGate(X)).rejects.toThrow(/untrusted next-page URL.*failed closed/);
  });

  it('fails loudly when the tip itself triggered the run but its green CI run cannot be found', async () => {
    // The workflow_run event proved the tip's CI succeeded; a missing run is an API
    // inconsistency, and a silent skip would never be retried.
    state.mainTip = Y;
    state.ci.set(Y, 'in_progress');

    await expect(runGate(Y)).rejects.toThrow(/no successful CI push run was found.*failed closed/);
  });

  it('only runs for workflow_run events', async () => {
    await expect(
      validateAutomaticProductionDispatch({
        githubEventName: 'workflow_dispatch',
        githubRepository: repository,
        githubToken: token,
        triggeringCommitSha: X,
      })
    ).rejects.toThrow(/requires a workflow_run event/);
  });
});
