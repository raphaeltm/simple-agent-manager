---
description: Identify next priorities — reconcile against shipped work, then rank what's actually open
argument-hint: [optional focus area, e.g. "security" or "UI"]
---

## User Input

```text
$ARGUMENTS
```

You are a prioritization analyst. Your job is to produce a reconciled, evidence-grounded
shortlist of what to work on next. If the user gave a focus area above, scope the analysis to it.

**The cardinal rule: do NOT rank anything until Step 0 has filtered out work that is already
shipped or stale.** Idea/task `status` and `priority` fields in SAM are routinely wrong — ideas
tied to merged PRs are left `draft`. Ranking unreconciled candidates wastes effort and recommends
work that is already done.

---

## Step 0 — Reconcile against ground truth (GATE — run FIRST, before any ranking)

For every candidate (idea, backlog task, remembered request), BEFORE it is allowed into ranking:

1. **Cross-check against merged code.** Take the candidate's title and any code paths/functions it
   names, then verify against main:
   ```bash
   git log --grep=<keyword> -i --oneline origin/main
   gh pr list --state merged --search "<keyword>"
   ```
2. **For partial matches, read the diff.** An idea that was expanded over time can be half-shipped —
   part merged, part still open. `git show <commit>` / `gh pr view <n> --files`.
3. **Classify each candidate:**
   - **SHIPPED** → drop it. (Also flag it so its idea/task status can be corrected — see Step 3.)
   - **PARTIAL** → re-scope it to ONLY the remaining, unmerged work.
   - **OPEN** → verify any named file/function still exists and is still unfixed, then admit to ranking.
4. **Trust merged code over status fields.** A `draft` idea may be fully shipped; an `in_progress`
   task may be abandoned. The code on main is the source of truth, not the board.

Only candidates classified OPEN or PARTIAL proceed to Step 2.

> Why this gate exists: in past sessions, the top 3 "priorities" pulled from the ideas board were
> already merged to main (PRs #1243, #1244, commit 81b31487) while their ideas sat `draft`. The
> reconciliation step is what caught it. Skipping it produces confidently-wrong recommendations.

---

## Step 1 — Gather signal (four tiers, highest authority first)

Pull candidates from all four tiers. Higher tiers override lower ones on conflict.

1. **Human intent (highest authority).** Anything the user said this session; SAM `list_policies`
   (hard gates unless explicitly a preference); `search_knowledge` for relevant entities
   (`User`, `Architecture`, `CodeQuality`, `BusinessStrategy`, surface names).
2. **Production reality.** Incidents, crashes, error spikes, analytics anomalies; CI/staging health
   (`gh run list`); open PRs (`gh pr list`) and failing checks; anything broken for real users.
3. **Curated backlog.** SAM `list_ideas`; `tasks/backlog/*.md`. (These feed Step 0 for reconciliation.)
4. **Strategic direction.** `strategy/` docs; CLAUDE.md "Recent Changes"; roadmap/engineering-strategy.

---

## Step 2 — Rank the survivors

Rank ONLY the OPEN/PARTIAL candidates from Step 0. Weigh:

- **Impact** — apply a multiplier for security and data-integrity work; user-facing breakage outranks polish.
- **Evidence quality** — a production metric or error log beats a guess or a "would be nice".
- **Effort & blast radius** — prefer high-impact/low-risk; flag anything that touches migrations, auth, or VM provisioning.
- **Reversibility** — reversible changes are cheaper to attempt; irreversible ones need more certainty.
- **Strategic fit** — alignment with stated direction and recent investment.
- **In-flight duplication** — check open PRs/active tasks so you don't recommend work already underway.

**Queue-jumpers** (rank to the top regardless of the above): anything the user explicitly flagged,
user-impacting security or correctness bugs, and anything actively broken in production.

---

## Step 3 — Output

Produce:

1. **Ranked shortlist of actually-open work.** For each item: one-line scope, impact/effort/evidence,
   and the Step-0 verification that proves it's still open (the commit/PR you checked, or "no match found").
2. **Stale-board cleanup list.** Separately list every candidate found SHIPPED in Step 0, with the
   merged PR/commit, so its idea/task status can be corrected (use SAM `update_idea` / move the task file).
3. **One recommended next action** with a one-sentence justification.

---

## SAM caveats

- Idea `priority` values are inconsistent (seen 0–70 with no shared scale) — treat as a weak hint only.
  Severity tags in titles and the Step-0 reconciliation carry far more signal than the numeric field.
- `search_knowledge` can fail with `LIKE or GLOB pattern too complex: SQLITE_ERROR` — fall back to
  `list_ideas` / `list_policies` and note the known backlog bug.
- This skill is **read-only by default.** Do not create tasks, ideas, or PRs unless the user asks —
  correcting stale idea status (Step 3) is fine since it only reconciles the board with reality.
