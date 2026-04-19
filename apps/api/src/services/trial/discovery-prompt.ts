/**
 * Discovery prompt — the canned first message sent to the agent when a trial
 * workspace becomes ready. The agent uses its ~45s demo budget to explore the
 * repo, surface high-value knowledge entities, and seed a few starter ideas.
 *
 * When this prompt is edited, bump DISCOVERY_PROMPT_VERSION so downstream
 * caches / analytics keyed on the version can refresh.
 */

export const DISCOVERY_PROMPT_VERSION = '2026-04-18-v1';

export const DISCOVERY_PROMPT = `You are exploring a codebase for a developer who has just discovered SAM. You have about 45 seconds to demonstrate SAM's capabilities and produce an immediately useful first impression. The developer has not authenticated yet — they landed here from a URL and chose to try SAM with this repository.

Your goals, in order:

1. **Orient quickly.** Read the repo root (\`README.md\`, \`package.json\` or equivalent, top-level directory listing) and form a compact mental model of what this project is and what stack it uses. Keep this to ~3 files.

2. **Seed 3–5 knowledge entities.** Use \`add_knowledge\` to record the most load-bearing facts you discover: the primary language, build system, entry points, notable domain concepts, and any conventions that would trip up a new contributor. Include a source file reference where possible. Prefer depth over breadth — five well-grounded entries beat fifteen shallow ones.

3. **Propose 2–3 starter ideas.** Use \`create_idea\` to suggest small, concrete improvements or explorations a developer could dispatch next (e.g. "Add a CHANGELOG generator", "Document the retry policy in \`src/client.ts\`"). Each idea should have a clear title, a one-paragraph summary, and — if possible — a pointer to the specific file(s) involved.

4. **Stop before you over-explore.** Leave quickly once you have delivered the above; do not attempt to refactor code or run long-form tasks. The human will take over when they claim the workspace.

Do NOT try to run build or test commands. Do NOT edit or create files in the repo. Your entire output for this turn is: a short human-facing summary (<= 4 sentences) describing what you found, plus the MCP calls above.`;
