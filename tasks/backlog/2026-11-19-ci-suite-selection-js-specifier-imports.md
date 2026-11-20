# CI suite selection does not follow `./x.js` imports of TypeScript files

## Problem

`scripts/quality/ci-suite-selection.test.ts` ("every file a suite reads outside its package is in
its filter") resolves an imported specifier by appending suffixes (`.ts`, `.tsx`, ...) to it. An
ESM-style `import ... from './x.js'` that TypeScript resolves to `x.ts` is never resolved, so the
scan silently stops there and does not report the files those modules import. Every module under
`scripts/` uses `.js` specifiers, so a suite's transitive reads through them are unchecked.

## Context

Found 2026-11-19 while narrowing the api-unit filter's `scripts/selfhost/**` to an explicit list
(branch `sam/l22b-celld-deploy-core`). Deleting the transitive entry
`scripts/selfhost/selfhost-migrations.ts` from the filter left the test green. Teaching
`resolveExisting` to map an imported `x.js` to `x.ts` reported these gaps:

- api-unit: `scripts/deploy/durable-object-migrations.ts` <- `scripts/selfhost/celld-config.ts`
  (added to the filter on that branch)
- packages: `scripts/deploy/{sync-wrangler-config,types,config,configure-agent-email,
cloudflare-rest,durable-object-migrations,environment-var-overrides,setup-token,
worker-var-defaults}.ts` and `apps/api/wrangler.toml`, read through
  `infra/__tests__/validate-pulumi-outputs.test.ts`

## Acceptance Criteria

- [ ] `resolveExisting` maps an imported `./x.js` to `./x.ts` when no `x.js` exists
- [ ] Every gap it then reports is added to the owning suite's filter (or the import removed)
- [ ] A test proves a transitive `.js`-specifier read is reported (delete one filter entry, red)
