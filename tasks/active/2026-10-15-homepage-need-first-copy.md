# Homepage copy that leads with the reader's need

## Problem

Raphaël (2026-10-15), after PR #2349 shipped the animated feature scenes:

- The row of feature buttons (Chat-First Development … Agents That Learn) is "pressed up against a line on the top side. It's really awkward. Let's either remove the line at the top or move those buttons down."
- "Can we also run a humanizer skill against the copy? (https://github.com/blader/humanizer) A lot of it feels 'sloppy'. Maybe save the humanizer skill in sam skills. Keep in mind the way a casual user would read the copy. As an example 'Real machines, not size labels' means fuckall to a user. And … 'You choose the strategy (Balanced, Pack, Spread, Smallest fit) and what happens when a provider runs out (Queue, Fail, Fallback chain).' means nothing to someone who doesn't know the system yet."
- "I think the graphics are good, but the copy doesn't speak to the *need* the user is facing. It's selling the engine, not the car." He asked for a skill that builds marketing copy around the end user's need, reviewed by a local agent, saved (for example as a "homepage copy skill"), then used to rewrite the homepage copy in a PR, plus a full-page homepage screenshot in the library.

Not asked: merging or deploying. Stop at a ready PR for approval.

## Research findings

- **Cramped buttons.** `apps/www/src/pages/index.astro` puts `<hr class="divider" />` directly before `#features`. The first child, `.showcase-index` in `FeatureShowcase.astro`, has `padding: 0 20px 48px`, so the pills sit on the line with no top spacing.
- **Copy problems** (live text dumped section by section): the hero H1 uses the buzzword "multi-agent", and the subtitle lists internals (Instant containers, VM workspaces, BYOC, provisioning). Feature sections lead with mechanics: provider SKUs, strategy and exhaustion option names, snapshot failure fallbacks, standing watches. How It Works says "Connect Your Runtime". The comparison table uses "Control plane: Workers Paid base plan" and "real SKUs". The roadmap uses internal milestone names and mentions "Missions". The CTA asks "Ready to run multi-agent workflows at scale?".
- **Voice and guardrails** (SAM knowledge entity ContentStyle; library `/marketing/product-hunt-launch-copy.md`, file 01KTB25TSVQNYBN2ESGMAXEGD1):
  - No em dashes, and no buzzwords such as "multi-agent".
  - Highlight that agents can start other agents and talk to them.
  - Never mention missions, handoff packets or policy propagation.
  - Keep docs and copy about outcomes, not internals.
  - Do not promise setup times.
  - Canonical one-liner, locked 2026-06-05: "Run AI coding agents in parallel on your own cloud".
  - Launch copy note: do not mention a hosted tier.
- **Shared copy fields.** Feature copy in `apps/www/src/data/features/*.json` is shared with `/features/` pages: `label` (pills, page titles, prev/next nav), `title` and `subtitle` (feature page hero and meta description), and `details[0]` (the first detail row on the feature page).
- **Humanizer.** github.com/blader/humanizer, MIT, v3.1.0 at commit 225a6f39ac85. Saved as SAM skill `humanizer` (01M4ZXM4R6TZV04DF9BYHEGVPP) with the license notice.

## Plan

1. Write a need-first copy skill. Have a local agent review it and trial it on real sections. Revise, then save it as SAM skill `homepage-copy`.
2. Fix the button spacing (move the pills down).
3. Using the skill, produce a claims ledger and a copy deck for every homepage string, then edit the copy:
   - The homepage-only components: Hero, the agent dock, How It Works, Comparison (SAM cells and labels only), Roadmap and the CTA.
   - The features' shared label, title and subtitle.
   - A homepage-only pitch (headline, body, caption), so the feature pages' detail rows keep their specifics.
4. Run the humanizer and a cold-reader review on the final copy.
5. Tests, build, Playwright visual check, and full-page screenshots (desktop and phone) uploaded to the library.
6. PR with the copy deck and evidence. Held with `needs-human-review`; no merge or deploy.

## Checklist

- [x] Copy skill drafted, reviewed by a local agent (GOOD WITH CHANGES; re-check after v2 → final fixes applied), saved as SAM skill `homepage-copy` (01M4ZYPHAS41V97VNP9XEWM5EH)
- [x] Button row spacing fixed (48 px above and below; was 0 px)
- [ ] Claims ledger and copy deck written
- [x] Copy rewritten (hero, agent dock, features, How It Works, comparison, roadmap, CTA, proof strip, hero layer labels, header button, page meta, scene descriptions)
- [ ] Humanizer pass and cold-reader review
- [ ] Tests updated, lint, typecheck, unit and Playwright suites pass
- [ ] Full-page screenshots (desktop and phone) uploaded to the library
- [ ] PR with copy deck, evidence, local reviews and CodeRabbit request; held for approval

## Skill review (local agent)

- Round 1, verdict GOOD WITH CHANGES. The reviewer trialled the skill on the hero, compute pools and durable sessions; a blind A/B cold reader preferred its output. Findings:
  - know the click: the Get Started buttons lead to an 8-step self-host guide;
  - shared fields and the slot table;
  - one need per section;
  - humanizer conflicts (case, dashes, restated layers);
  - overpromising examples (7-day limit; Instant has no Docker);
  - source ranking;
  - 375 px, cold-reader questions, a spelled-out product name, the framing line.
- Round 2, on v2: all addressed except the field map, which described the branch's new `homepage` field as if `main` had it. It is now worded to hold before and after merge. Also added that Instant work is not committed or pushed, and that the name must be visible in the hero.

## Acceptance criteria

- The feature buttons have clear space below the divider on desktop and phone.
- A casual reader can tell from the headlines alone what SAM does and who it is for.
- No SAM-internal jargon, option names or failure modes remain in homepage copy. Every claim is true today.
- No em dashes or "multi-agent" buzzwords. Missions are not mentioned.
- The humanizer and need-first copy skills are saved in SAM skills.
- Full-page homepage screenshots are in the library.
