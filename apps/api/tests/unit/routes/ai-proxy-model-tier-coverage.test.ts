/**
 * The admin model-tier restriction is a property of platform AI spend, not of one route
 * (`.claude/rules/61-guards-must-cover-every-runtime.md`): every route file that forwards a user
 * request upstream on platform credentials must run the gate in each of its handlers. Adding a
 * forwarding route without the gate fails here rather than shipping an unrestricted path.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

/** Calls that send a request upstream on platform credentials. */
const PLATFORM_FORWARDING_CALL =
  /\b(?:resolveUpstreamAuth|forwardToAnthropic|forwardToOpenAI|forwardToOpenAIResponses|forwardToWorkersAI)\(/;
const TIER_GATE_CALL = /\b(?:enforceModelTier|enforceAnthropicModelTier)\(/g;
const POST_HANDLER = /\.post\(\s*'/g;
/** Defines the forwarders; it is not a route. */
const FORWARDER_MODULE = path.join(SRC_ROOT, 'routes', 'ai-proxy-upstream.ts');

const routeSources = collectSourceFiles(path.join(SRC_ROOT, 'routes')).map((file) => ({
  file: path.relative(SRC_ROOT, file),
  source: readFileSync(file, 'utf8'),
}));
const forwardingRoutes = routeSources.filter(
  ({ file, source }) =>
    path.join(SRC_ROOT, file) !== FORWARDER_MODULE && PLATFORM_FORWARDING_CALL.test(source)
);

describe('every platform-credential AI proxy route runs the model-tier gate', () => {
  it('finds the platform forwarding routes, so a broken scan cannot pass as "all clear"', () => {
    expect(routeSources.length).toBeGreaterThan(100);
    expect(forwardingRoutes.map(({ file }) => file)).toEqual(
      expect.arrayContaining(['routes/ai-proxy.ts', 'routes/ai-proxy-anthropic.ts'])
    );
  });

  it.each(forwardingRoutes.map(({ file, source }) => [file, source] as const))(
    '%s gates every POST handler',
    (_file, source) => {
      const handlers = source.match(POST_HANDLER)?.length ?? 0;
      const gates = source.match(TIER_GATE_CALL)?.length ?? 0;
      expect(handlers).toBeGreaterThan(0);
      expect(gates).toBeGreaterThanOrEqual(handlers);
    }
  );

  it('BYO-key passthrough stays outside the gate because it never resolves a platform credential', () => {
    const passthrough = routeSources.find(({ file }) => file === 'routes/ai-proxy-passthrough.ts');
    expect(passthrough).toBeDefined();
    // If passthrough ever reaches for platform credentials, it becomes platform spend and must be
    // gated like the routes above.
    expect(passthrough?.source).not.toMatch(
      /\b(?:resolveUpstreamAuth|getPlatformAgentCredential|forwardTo[A-Z]\w*)\(/
    );
  });
});
