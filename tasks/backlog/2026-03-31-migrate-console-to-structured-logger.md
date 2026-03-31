# Migrate console.* calls to structured logger in apps/api/

## Problem

`apps/api/src/lib/logger.ts` provides structured JSON logging (`log.info/warn/error/debug`), but 47 files still use raw `console.*` — 138 calls total. This breaks log consistency: some logs are machine-parseable JSON, others are plain text with ad-hoc prefixes.

## Research Findings

### Current Logger API
- `log.info(event, details?)`, `log.warn(event, details?)`, `log.error(event, details?)`, `log.debug(event, details?)`
- `createInstrumentedLogger(db, waitUntil)` — wraps `log` with D1 error persistence
- Output: single-line JSON with `{timestamp, level, event, ...details}`
- Uses `console.*` internally (which is correct — logger.ts is the only file that should)

### Gaps in Current Logger
1. **No module context** — many files use `[module]` prefix pattern (e.g., `[transcribe]`, `[Auth]`, `[client-error]`)
2. **No Error serialization** — callers manually extract `err.message`; Error objects would stringify to `{}`
3. **No child/scoped loggers** — would reduce boilerplate in files with many calls

### Console Call Patterns Found
1. **Already JSON-structured**: `console.error(JSON.stringify({event: 'x', ...}))` — 15+ calls in acp-sessions.ts, index.ts, etc. Easy migration.
2. **Prefix-tagged**: `console.log('[transcribe] msg', data)` — common in transcribe.ts, auth.ts. Need event name conversion.
3. **Error with context**: `console.error('Failed to X:', err)` — common in nodes.ts, github.ts. Need Error serialization.
4. **Inline objects**: `console.log('msg', { key: val })` — many files. Direct migration.

### ESLint Config
- Root `.eslintrc.cjs` — no `no-console` rule currently
- Need to add override for `apps/api/src/**/*.ts` with `no-console: error`, excluding `lib/logger.ts`

## Implementation Checklist

### Phase 1: Enhance Logger
- [ ] Add `createModuleLogger(module)` that prefixes event names with `module.`
- [ ] Add `serializeError(err)` helper for Error objects (message, stack, cause)
- [ ] Keep it lightweight — no log level filtering needed (Cloudflare handles filtering)

### Phase 2: Migrate Tier 1 (10 files, ~65 calls)
- [ ] `routes/transcribe.ts` (12 calls)
- [ ] `durable-objects/project-data/idle-cleanup.ts` (9 calls)
- [ ] `services/nodes.ts` (8 calls)
- [ ] `durable-objects/project-data/index.ts` (8 calls)
- [ ] `durable-objects/project-data/acp-sessions.ts` (8 calls)
- [ ] `index.ts` (7 calls)
- [ ] `routes/projects/files.ts` (6 calls)
- [ ] `auth.ts` (6 calls)
- [ ] `services/analytics-forward.ts` (5 calls)
- [ ] `routes/workspaces/runtime.ts` (5 calls)

### Phase 3: Migrate Tier 2 (37 files, ~72 calls)
- [ ] All remaining files with 1-5 calls each

### Phase 4: Add ESLint Rule
- [ ] Add `no-console: error` override for `apps/api/src/**/*.ts`
- [ ] Exclude `apps/api/src/lib/logger.ts` from the rule
- [ ] Exclude test files from the rule
- [ ] Run `pnpm lint` — verify zero violations

### Phase 5: Verify
- [ ] Grep confirms zero `console.*` in `apps/api/src/` outside `lib/logger.ts`
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm lint` passes

## Acceptance Criteria
- [ ] Zero raw `console.*` calls in `apps/api/src/` outside of `lib/logger.ts`
- [ ] All log output is structured JSON
- [ ] ESLint `no-console` rule enforced for `apps/api/src/`
- [ ] Logger supports module context and error serialization
- [ ] All existing tests pass

## References
- Idea: `01KN2PTKNNQX8N8FBH1KWZMQVT`
- Logger: `apps/api/src/lib/logger.ts`
- ESLint config: `.eslintrc.cjs`
