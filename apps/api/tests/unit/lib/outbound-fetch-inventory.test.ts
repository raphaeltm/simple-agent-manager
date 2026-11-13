/**
 * Machine-checked inventory of outbound requests (self-host T5, rule 61), per call site.
 *
 * outbound-fetch-analyzer.ts walks every src/ file, and every file of the packages the worker
 * modularization (#2681) moved worker code into, with the TypeScript parser and finds every
 * call that can send a request: the global fetch in any spelling, fetchWithTimeout, local
 * aliases, injected fetchers, and `.fetch(` on bindings and stubs. A site passes only if it is a
 * call to a guard entry point (guardedFetch, fetchChatTarget, fetchProxyUpstream) or has an
 * entry in outbound-fetch-allowlist.ts naming that exact file, function and call, who controls
 * the URL, and why. Counts are pinned exactly, so a new site, a removed site and a stale entry
 * all fail with the site named.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OUTBOUND_FETCH_ALLOWLIST } from './outbound-fetch-allowlist';
import { analyzeSource, type CallCategory, type CallSite } from './outbound-fetch-analyzer';

const SRC = resolve(import.meta.dirname, '../../../src');
const PACKAGES = resolve(import.meta.dirname, '../../../../../packages');

/**
 * Packages holding code that runs in this Worker (moved out of src/ by #2681, the same set
 * scripts/quality/ast-checks.ts scans). Their sites are keyed `@<package>/<path under src>`.
 */
const WORKER_PACKAGES = [
  'agent-email',
  'ai-proxy',
  'app-deployment',
  'operations',
  'project-data',
  'repo-hosting',
  'scheduler-core',
  'worker-core',
];

/**
 * Exact counts. When you add, remove or guard a call site, update these and the allowlist in
 * the same change; the failure message lists exactly which sites moved.
 */
const EXPECTED_COUNTS: Record<CallCategory | 'total', number> = {
  total: 150,
  guarded: 17,
  outbound: 104,
  binding: 29,
};

/** User- and admin-chosen URL sites that must stay on the guard (rule 61 enumeration). */
const MUST_BE_GUARDED = [
  'routes/ai-proxy-passthrough-prepare.ts › fetchProxyUpstream › guardedFetch',
  'routes/ai-proxy-passthrough.ts › POST /:wstoken/anthropic/v1/messages › fetchProxyUpstream',
  'routes/ai-proxy-passthrough.ts › POST /:wstoken/anthropic/v1/messages/count_tokens › fetchProxyUpstream',
  'routes/ai-proxy-passthrough.ts › POST /:wstoken/openai/v1/chat/completions › fetchProxyUpstream',
  'services/llm-chat-target.ts › fetchChatTarget › guardedFetch',
  'services/ai-proxy-shared.ts › fetchWorkersAIChatCompletion › fetchChatTarget',
  'routes/ai-proxy-upstream.ts › forwardToWorkersAI › fetchChatTarget',
  'services/debug-agent-tools.ts › complete › fetchChatTarget',
  'durable-objects/sam-session/agent-loop-llm.ts › callOpenAIChatLLM › fetchChatTarget',
  'durable-objects/sam-session/operator/model.ts › fetch › fetchChatTarget',
  '@repo-hosting/gitlab.ts › gitlabFetch › guardedFetch',
  'services/gitlab-login-provider.ts › fetchGitLabUserInfo › guardedFetch',
  'routes/mcp/check-dns-status.ts › handleCheckDnsStatus › guardedFetch',
  // Operator-chosen issuer (AGENT_SIGN_IN_TRUST); on self-host the Worker shares a host with
  // loopback services and the metadata server.
  'services/agent-sign-in/verify.ts › fetchIssuerKeys › guardedFetch',
  // Admin-chosen speech endpoint (speech.transcription.* / speech.synthesis.*).
  'services/speech-endpoints.ts › send › guardedFetch',
  // Advisory stalled-loop verdict on the admin's LLM endpoint.
  'services/stalled-task-classifier-endpoint.ts › classifyLoopWithLlmEndpoint › fetchChatTarget',
  // User-chosen importUrl for a SAM-hosted repository (forge allowlist on every request).
  'services/hosted-git/import.ts › cappedFetch › guardedFetch',
];

const keyOf = (site: Pick<CallSite, 'file' | 'fn' | 'call'>): string =>
  `${site.file} › ${site.fn} › ${site.call}`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function scanSrc(): CallSite[] {
  const roots = [
    { dir: SRC, prefix: '' },
    ...WORKER_PACKAGES.map((name) => ({ dir: join(PACKAGES, name, 'src'), prefix: `@${name}/` })),
  ];
  return roots.flatMap(({ dir, prefix }) =>
    sourceFiles(dir).flatMap((path) =>
      analyzeSource(`${prefix}${relative(dir, path)}`, readFileSync(path, 'utf8'))
    )
  );
}

interface Tally {
  category: CallCategory;
  count: number;
}

function tallyByKey(sites: readonly CallSite[]): Map<string, Tally> {
  const tally = new Map<string, Tally>();
  for (const site of sites) {
    const key = keyOf(site);
    const entry = tally.get(key);
    if (entry) entry.count += 1;
    else tally.set(key, { category: site.category, count: 1 });
  }
  return tally;
}

/** Every allowlist problem for these sites, one line each; [] when the inventory holds. */
function inventoryProblems(sites: readonly CallSite[]): string[] {
  const tally = tallyByKey(sites);
  const listed = new Map(OUTBOUND_FETCH_ALLOWLIST.map((entry) => [keyOf(entry), entry]));
  const problems: string[] = [];
  for (const [key, { category, count }] of tally) {
    if (category === 'guarded') continue;
    const entry = listed.get(key);
    if (!entry) {
      problems.push(`unguarded ${category} call site not in the allowlist: ${key}`);
      continue;
    }
    if ((entry.controller === 'binding') !== (category === 'binding')) {
      problems.push(
        `${key}: listed as ${entry.controller} but the analyzer sees a ${category} call`
      );
    }
    if ((entry.count ?? 1) !== count) {
      problems.push(`${key}: allowlist says ${entry.count ?? 1} site(s), found ${count}`);
    }
  }
  for (const key of listed.keys()) {
    if (!tally.has(key)) problems.push(`stale allowlist entry (no such call site): ${key}`);
  }
  return problems;
}

describe('outbound fetch analyzer: every spelling is a call site', () => {
  const sitesIn = (text: string): string[] =>
    analyzeSource('probe.ts', text).map((site) => `${site.category} ${site.fn} ${site.call}`);

  it('reports three spellings of an unguarded user-URL fetch', () => {
    expect(
      sitesIn(`
        export async function viaGlobal(userUrl: string) { return globalThis.fetch(userUrl); }
        const send = fetch;
        export async function viaAlias(userUrl: string) { return send(userUrl); }
        type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
        export async function viaInjected(userUrl: string, fetcher: Fetcher) { return fetcher(userUrl); }
      `)
    ).toEqual([
      'outbound viaGlobal globalThis.fetch',
      'outbound viaAlias send',
      'outbound viaInjected fetcher',
    ]);
  });

  it('reports a Request object, call/apply, bind, destructuring, ?? fallback and element access', () => {
    expect(
      sitesIn(`
        export function a(u: string) { return fetch(new Request(u)); }
        export function b(u: string) { return fetch.call(globalThis, u); }
        const bound = fetch.bind(globalThis);
        export function c(u: string) { return bound(u); }
        const { fetch: grabbed } = globalThis;
        export function d(u: string) { return grabbed(u); }
        export function e(u: string, deps: { fetcher?: typeof fetch }) {
          const run = deps.fetcher ?? fetch;
          return run(u);
        }
        export function f(u: string) { return self.fetch(u) && globalThis['fetch'](u); }
        export function g(u: string, opts: { fetchFn: typeof fetch }) { return opts.fetchFn(u); }
        export function h(u: string) { return fetchWithTimeout(u, {}, 1000); }
      `)
    ).toEqual([
      'outbound a fetch',
      'outbound b fetch.call',
      'outbound c bound',
      'outbound d grabbed',
      'outbound e run',
      'outbound f self.fetch',
      "outbound f globalThis['fetch']",
      'outbound g opts.fetchFn',
      'outbound h fetchWithTimeout',
    ]);
  });

  it('control: guard calls are guarded, stubs are bindings, look-alikes are not calls', () => {
    expect(
      sitesIn(`
        export function guarded(u: string) { return guardedFetch(u, {}, policy); }
        export function chat(t: Target) { return fetchChatTarget(t, {}); }
        export function stub(env: Env, req: Request) { return env.PROJECT_DATA.get(id).fetch(req); }
        export function lookAlike(u: string) { return fetchNodeAgentStatus(u) && prefetch(u); }
        export class Box { async fetch(req: Request) { return new Response('x'); } }
      `)
    ).toEqual([
      'guarded guarded guardedFetch',
      'guarded chat fetchChatTarget',
      'binding stub env.PROJECT_DATA.get(id).fetch',
    ]);
  });

  it('names anonymous route handlers by method and path', () => {
    expect(sitesIn(`app.post('/x/:id', async (c) => fetch(c.req.url));`)).toEqual([
      'outbound POST /x/:id fetch',
    ]);
  });
});

describe('outbound fetch inventory (apps/api/src and the worker packages)', () => {
  const sites = scanSrc();

  it('every unguarded call site is listed, with the right kind and count, and no entry is stale', () => {
    expect(inventoryProblems(sites)).toEqual([]);
  });

  it('pins the exact number of call sites per category', () => {
    const actual: Record<string, number> = { total: sites.length };
    for (const site of sites) actual[site.category] = (actual[site.category] ?? 0) + 1;
    expect(actual).toEqual(EXPECTED_COUNTS);
  });

  it('every allowlist entry says who controls the URL and why', () => {
    const vague = OUTBOUND_FETCH_ALLOWLIST.filter((entry) => entry.reason.trim().length < 15);
    expect(vague.map(keyOf)).toEqual([]);
    const keys = OUTBOUND_FETCH_ALLOWLIST.map(keyOf);
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
  });

  it('the user- and admin-chosen URL sites stay on the guard', () => {
    const guarded = new Set(sites.filter((site) => site.category === 'guarded').map(keyOf));
    expect(MUST_BE_GUARDED.filter((key) => !guarded.has(key))).toEqual([]);
  });

  it('an unguarded call added to a real source file fails the inventory, in three spellings', () => {
    const probe = analyzeSource(
      'routes/probe-new-feature.ts',
      `
        export async function a(url: string) { return globalThis.fetch(url); }
        const send = fetch;
        export async function b(url: string) { return send(url); }
        export async function c(url: string, deps: { fetcher: typeof fetch }) { return deps.fetcher(url); }
      `
    );
    expect(inventoryProblems([...sites, ...probe])).toEqual([
      'unguarded outbound call site not in the allowlist: routes/probe-new-feature.ts › a › globalThis.fetch',
      'unguarded outbound call site not in the allowlist: routes/probe-new-feature.ts › b › send',
      'unguarded outbound call site not in the allowlist: routes/probe-new-feature.ts › c › deps.fetcher',
    ]);
  });
});
