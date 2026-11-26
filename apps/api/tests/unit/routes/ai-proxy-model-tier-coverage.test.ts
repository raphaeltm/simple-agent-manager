/**
 * Model admission is a property of platform AI spend, not of one route
 * (`.claude/rules/61-guards-must-cover-every-runtime.md`): every POST handler that spends platform
 * credentials must check the operator model allowlist and the admin model-tier restriction before
 * it resolves a credential or forwards anything upstream. A new handler — or a refactor that moves
 * a gate below the spend — fails here rather than shipping an ungoverned path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

/** Calls that resolve a platform credential or send a request upstream on one (not definitions). */
const PLATFORM_SPEND_CALL =
  /(?<!function )\b(?:resolveUpstreamAuth|resolveOpenAIProxyCredential|forwardToAnthropic|forwardToOpenAI|forwardToOpenAIResponses|forwardToWorkersAI|upstreamFetch)\(/;
/**
 * The native Anthropic routes run their gates in one shared admission step
 * (`ai-proxy-anthropic-prelude.ts`). A call to it counts as both gates only because the last test
 * below proves that step gates before it resolves a credential or selects the fake upstream.
 */
const ANTHROPIC_ADMISSION_CALL = /\badmitAnthropicProxyRequest\(/;
const ALLOWLIST_GATE_CALL = new RegExp(
  `\\b(?:validateAllowedModel|validateAnthropicAllowedModel)\\(|${ANTHROPIC_ADMISSION_CALL.source}`
);
const TIER_GATE_CALL = new RegExp(
  `\\b(?:enforceModelTier|enforceAnthropicModelTier)\\(|${ANTHROPIC_ADMISSION_CALL.source}`
);
/** Each POST handler runs from its registration to the next one (or the end of the file). */
const POST_HANDLER_START = /(?=\.post\(\s*['"`])/;

/**
 * Comments must not satisfy a gate: a JSDoc or trailing `// enforceModelTier(…)` is not a call.
 * A line comment needs whitespace (or the line start) before it, so `https://…` strings survive.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const routeSources = collectSourceFiles(path.join(SRC_ROOT, 'routes')).map((file) => ({
  file: path.relative(SRC_ROOT, file),
  source: stripComments(readFileSync(file, 'utf8')),
}));
const spendingRoutes = routeSources.filter(({ source }) => PLATFORM_SPEND_CALL.test(source));
const handlers = spendingRoutes.flatMap(({ file, source }) =>
  source
    .split(POST_HANDLER_START)
    .slice(1)
    .map((handler) => ({
      name: `${file} ${handler.match(/\.post\(\s*['"`]([^'"`]+)/)?.[1] ?? '?'}`,
      handler,
    }))
);

describe('every platform-credential AI proxy handler admits the model before spending', () => {
  it('finds the platform-spending routes and handlers, so a broken scan cannot pass as "all clear"', () => {
    expect(routeSources.length).toBeGreaterThan(100);
    expect(spendingRoutes.map(({ file }) => file).sort()).toEqual([
      'routes/ai-proxy-anthropic-count-tokens.ts',
      'routes/ai-proxy-anthropic-prelude.ts',
      'routes/ai-proxy-anthropic.ts',
      'routes/ai-proxy-upstream.ts',
      'routes/ai-proxy.ts',
    ]);
    expect(handlers.map(({ name }) => name).sort()).toEqual([
      'routes/ai-proxy-anthropic-count-tokens.ts /messages/count_tokens',
      'routes/ai-proxy-anthropic.ts /messages',
      'routes/ai-proxy.ts /chat/completions',
      'routes/ai-proxy.ts /responses',
    ]);
  });

  it.each(handlers.map(({ name, handler }) => [name, handler] as const))(
    '%s checks the allowlist and the tier gate before any platform spend',
    (_name, handler) => {
      const spendAt = handler.search(PLATFORM_SPEND_CALL);
      const allowlistAt = handler.search(ALLOWLIST_GATE_CALL);
      const tierAt = handler.search(TIER_GATE_CALL);

      expect(spendAt).toBeGreaterThan(-1);
      expect(allowlistAt).toBeGreaterThan(-1);
      expect(allowlistAt).toBeLessThan(spendAt);
      expect(tierAt).toBeGreaterThan(-1);
      expect(tierAt).toBeLessThan(spendAt);
    }
  );

  it('the shared Anthropic admission step gates before it resolves a credential or selects the fake', () => {
    const prelude = routeSources.find(
      ({ file }) => file === 'routes/ai-proxy-anthropic-prelude.ts'
    );
    expect(prelude).toBeDefined();
    const body = prelude!.source.slice(
      prelude!.source.search(/export async function admitAnthropicProxyRequest\(/)
    );
    const allowlistAt = body.search(/\bvalidateAnthropicAllowedModel\(/);
    const tierAt = body.search(/\benforceAnthropicModelTier\(/);
    const credentialAt = body.search(/\bresolveUpstreamAuth\(/);
    const fakeAt = body.search(/\bresolveAiTestUpstream\(/);
    for (const spendAt of [credentialAt, fakeAt]) {
      expect(spendAt).toBeGreaterThan(-1);
      expect(allowlistAt).toBeGreaterThan(-1);
      expect(allowlistAt).toBeLessThan(spendAt);
      expect(tierAt).toBeGreaterThan(-1);
      expect(tierAt).toBeLessThan(spendAt);
    }
  });

  it('BYO-key passthrough stays outside the gates because it never resolves a platform credential', () => {
    const passthrough = routeSources.find(({ file }) => file === 'routes/ai-proxy-passthrough.ts');
    expect(passthrough).toBeDefined();
    // If passthrough ever reaches for platform credentials, it becomes platform spend and must be
    // gated like the routes above.
    expect(passthrough?.source).not.toMatch(
      /\b(?:resolveUpstreamAuth|getPlatformAgentCredential|forwardTo[A-Z]\w*)\(/
    );
  });
});
