# SAM assistant: prose history, documentation tools, single-counted AI usage

## Problem

Three follow-ups for the private SAM assistant (`SamSession` DO, Mastra operator):

1. **Usage double count** (`tasks/backlog/2026-10-21-ai-usage-totals-double-count-sam.md`).
   `GET /api/usage/ai` sums AI Gateway logs and local provider meters. Each SAM model step goes
   through AI Gateway (with `metadata.userId`) and is also written to the local provider meter by
   `recordOperatorStepUsage`, so every SAM request is counted twice.
2. **History primes JSON replies** (`tasks/backlog/2026-10-21-sam-history-records-primes-json-replies.md`).
   `projectOperatorContext` shows each earlier turn as the user's message plus an assistant
   message that is a JSON status record. Every earlier assistant turn the model sees is JSON, and
   GLM 5.3 Flash copied a record in 2 of 5 staging runs (rejected by the guard, but ~15 s and
   double tokens each time).
3. **SAM does not know what SAM is.** The assistant has platform operations but no product
   knowledge. It cannot explain concepts, features, settings or how-tos. Raphaël asked for tools
   so it can understand SAM and answer users better, for example by reading SAM's own docs.

## Research Findings

### Usage accounting

- `operator/model.ts:recordOperatorStepUsage` calls `incrementTokenUsage` (daily token budget,
  read by `checkAiUsageGate`) and `incrementProviderUsage` (local provider meter).
- The local provider meter is read only by `GET /api/usage/ai` (`routes/usage.ts`, both
  branches). The route doc says meters exist for direct passthrough requests that bypass AI
  Gateway. `services/ai-token-usage-accounting.ts` writes meters only when `options.provider` is
  set (passthrough), so gateway-routed proxies are not metered locally.
- `buildWorkersAIGatewayUrl` and `buildAnthropicGatewayUrl` route through AI Gateway exactly
  when `env.AI_GATEWAY_ID` is set. Without it, requests go direct and no gateway log exists.
- Monthly cost cap reads gateway logs (`ai-monthly-cost-cron.ts`); daily budget reads the
  token counter. Neither reads provider meters.
- Fix at the writer: meter locally only when the step did not go through AI Gateway. The reader
  cannot de-duplicate aggregated daily counters. Existing duplicate meter entries (SAM launched
  2026-10-20) stay in past days and age out of the selectable periods; no migration.

### History projection

- Guarantees pinned by `tests/unit/durable-objects/sam-operator-context.test.ts`: ungrounded
  historical replies omitted from inference (canonical rows and FTS untouched); user constraints
  kept verbatim; bounded action references with truncation disclosure; no raw action input or
  result text; interrupted/cancelled/failed states; nested fork provenance; legacy plain
  conversation; dated turns; record-shaped stored answers left out; user-requested JSON answers
  kept; malformed URLs; oversized replies; role+content attribution for forks; whole-group
  trimming; exact current request last.
- Mastra hoists `role: 'system'` input messages into the system prompt (`MessageList.addSystem`),
  so per-turn notes cannot be system messages.
- Design: each earlier turn becomes the user's message prefixed by one server note line, then the
  turn's retained reply as a plain assistant message. Example note:
  `[Earlier turn · 2026-10-20T14:03:05.000Z · SAM replied · ran sam_tasks_list completed]`.
  The note carries time, turn state, whether the reply is hidden, and bounded operation
  references (`+N more`). No JSON appears anywhere in projected history. A group whose replies
  were all left out contributes only its user message.
- Instructions explain the note once. `REPLY_FORMAT` (added only because of JSON priming) is
  removed.
- The publication guard keeps rejecting legacy record copies (stored copies from before PR #2398
  may exist and must stay out of context) and also rejects replies that reproduce the note
  marker, so a stored reply can never pass for a server note.

### Documentation tools

- Docs: 39 Starlight pages under `apps/www/src/content/docs/docs/` (~1.33 MB). The API Worker
  bundle is 27.6 MB raw / 5.13 MB gzip against Cloudflare's 10 MB compressed limit; all docs
  add ~0.35 MB gzip.
- The www site serves only HTML (no raw markdown or llms.txt), so runtime fetch would need HTML
  parsing and an external dependency. Bundle the docs with the Worker instead: they then match
  the deployed code.
- Wrangler `[[rules]] type = "Text"` bundles `.md`/`.mdx` imports as hashed text modules
  (verified with a dry-run prototype, `.tmp/textmod`). Wrangler environments inherit top-level
  `rules`; `sync-wrangler-config.ts` round-trips the whole TOML.
- Test harnesses need the same rule: a Vite plugin for the unit/workers/debugging Vitest
  configs, and `tests/workers/support/sam-native-runtime.ts` must add the rule to its generated
  config and load the emitted text modules into Miniflare.
- Sections can be very large (`reference/configuration.md` "Durable Object Limits" is 173 KB),
  so reads must page within a section, and search must score passages, not whole sections.
- `sam_private_history_search` is the pattern for a non-registry operator tool (no receipt).
  Live steps read `query` from inputs and count `results` automatically (`operator/live.ts`).
- Docs mention app route templates such as `/projects/:id/sessions/:sessionId/sleep`. The
  guard rejects any `/projects/...` link that is not in this turn's receipts, so an answer that
  quotes an API route would be interrupted. A route template names no resource; exempt
  candidates whose first segment after `/projects/` is a `:param` placeholder. Docs contain no
  labelled ULIDs.
- Docs link base: there is no API-side website URL. The web app uses `VITE_PUBLIC_WEBSITE_URL`
  with an inline default. Add `SAM_DOCS_SITE_URL` to `resolveSamConfig` with
  `DEFAULT_SAM_DOCS_SITE_URL = 'https://www.simple-agent-manager.org'` (the apex 301-redirects
  to `www`). It is a domain, so it is bootstrap configuration: record a bootstrap exception in
  `scripts/quality/runtime-tunables-baseline.json`. No `[vars]` entry (code default).
- Reuse existing config: `searchLimit` for result count, `maxToolResultBytes` for read size.

## Implementation Checklist

### Usage

- [ ] `recordOperatorStepUsage`: write the local provider meter only when `env.AI_GATEWAY_ID`
      is unset; always charge the daily token budget. Comment names the URL builders.
- [ ] Native workerd test: a gateway-routed GLM turn charges the daily budget and writes no
      provider meter; with the gateway unset, one local meter entry at the cached price.
- [ ] Update `/api/usage/ai` route doc comment if needed; correct the backlog acceptance
      criteria (reader-side test is not the right shape) in this task's notes.

### History projection

- [ ] Rewrite `projectOperatorContext` to project notes + prose replies (no JSON).
- [ ] Note builder: time, state, hidden reply, bounded operation refs with `+N more`.
- [ ] Guard: reject the note marker in replies; keep legacy record-copy rejection; update
      comments in `grounding.ts`.
- [ ] `agent.ts`: replace the record sentence in `OPERATOR_INSTRUCTIONS` with the note
      explanation; remove `REPLY_FORMAT`.
- [ ] Rewrite `sam-operator-context.test.ts` to the new shape, keeping every guarantee.
- [ ] Update `sam-grounding-runtime.test.ts` (native Mastra) to assert the projected shape the
      model receives, and the record-copy test in `sam-live-stream.test.ts`.

### Documentation tools

- [ ] `wrangler.toml` Text rule for `**/*.md` and `**/*.mdx`; `.d.ts` module declarations.
- [ ] Vite text-module plugin shared by `vitest.config.ts`, `vitest.workers.config.ts`,
      `vitest.debugging.workers.config.ts`.
- [ ] `sam-native-runtime.ts`: rule in generated config + Text modules in Miniflare.
- [ ] `services/sam-docs/corpus.ts`: explicit import of every docs page.
- [ ] `services/sam-docs/search.ts`: parse (frontmatter title/description, drop MDX imports,
      absolute `/docs/` links, heading anchors), passages, BM25-style ranking with heading/title
      boost, total order, excerpts, paged reads.
- [ ] `operator/docs-tools.ts`: `sam_docs_search` and `sam_docs_read` with account/kill-switch
      checks like `sam_private_history_search`; wired into `operatorTools`.
- [ ] `SAM_DOCS_SITE_URL` in shared config, `Env`, bootstrap exception, configuration docs.
- [ ] Instructions: when to use the docs tools and that docs are not current status.
- [ ] Guard exemption for `/projects/:param` route templates, with attack + control tests.
- [ ] Web: live-step words for both tools (`sam-receipts.ts`); `page` in live targets.
- [ ] Tests: corpus enumeration (every page registered, minimum count), parser, ranking (skew,
      determinism, disclosure), read paging, tools through native Mastra (tool list + a docs
      search turn).

### Docs

- [ ] `guides/sam-assistant.md`: docs questions, history behaviour.
- [ ] `architecture/sam-account-assistant.md`: prose projection, notes, guard, docs tools,
      usage metering.
- [ ] `reference/configuration.md`: `SAM_DOCS_SITE_URL`.
- [ ] `reference/api.md` if the SAM contract section lists tools.

## Acceptance Criteria

- [ ] A SAM step that reaches AI Gateway is counted once by `GET /api/usage/ai`; the daily
      token budget still counts it. Without AI Gateway, it is metered locally once.
- [ ] Projected history contains no JSON status records; earlier replies are plain assistant
      prose; each earlier user message starts with a dated server note; every guarantee listed in
      Research Findings still holds.
- [ ] A reply that reproduces a server note or a legacy record is never published.
- [ ] SAM can search and read every docs page; results are ranked, disclose what was left out,
      link to the public docs, and page through long sections.
- [ ] An answer quoting an API route template is not rejected; a link with a real but
      ungrounded project ID still is.
- [ ] Staging: bounded live turns (within the smoke user's daily cap, no cap increase) show a
      docs question answered with a docs link, and the record/note copy rate after the change
      (before: 2 of 5 GLM runs copied a record).

## References

- `apps/api/src/durable-objects/sam-session/operator/{agent,context,grounding,model,operations,live}.ts`
- `apps/api/src/routes/usage.ts`, `apps/api/src/services/ai-token-budget.ts`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`,
  `apps/api/.claude/rules/65-capped-selection-must-rank-and-disclose.md`,
  `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`,
  `.claude/rules/07-env-and-urls.md` (runtime tunables), `.claude/rules/18-file-size-limits.md`
