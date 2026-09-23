---
title: Session Resource History
description: Read the CPU, memory, and I/O history SAM retains for a workspace so you can explain a crash, a slowdown, or an oversized machine.
---

Every VM-backed workspace records what it actually used — CPU, memory, disk I/O, and
out-of-memory events — and keeps that history after the machine is gone. Open **Resources**
in a chat session's tool rail to read it.

This answers questions you previously had to guess at:

- _The agent died mid-task. Did it run out of memory?_
- _This session took 40 minutes. Was it working, or waiting?_
- _Am I paying for a 16 GB machine to run something that peaks at 900 MB?_

## Where to find it

In a project chat, open the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail)
on the right edge and click **Resources** (the activity icon). The panel opens as a side drawer on
desktop and full-screen on mobile.

The button is always there, including on sessions that already ended — which is usually when you
want it, because the workspace is gone and this is the only record left.

![The Resources drawer for a chat session: stat cards reading CPU peak 4120 ms/sample, RAM peak 3.4 GB, I/O total 384 MB read and 1.1 GB write, and 684 samples with 1 gap; an amber banner reading "1 OOM event observed in retained samples"; a detail timeline chart with a green CPU line, a dashed purple RAM line, blue tool-window bands and an amber OOM marker; a Tool windows list; and a collapsed "2 chunks" disclosure.](/images/docs/session-resources-drawer.png)

On mobile the same panel fills the screen and scrolls, with the stat cards and the OOM
banner first so the answer is above the fold.

## Reading the panel

The drawer stacks four things, in the order you normally need them.

### 1. Stat cards

Four numbers for the whole session:

| Card          | What it means                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------- |
| **CPU peak**  | The busiest single sample, in milliseconds of CPU time. See the conversion below.                 |
| **RAM peak**  | The highest memory the workspace held at any sampled moment.                                      |
| **I/O total** | Bytes read and written over the session.                                                          |
| **Samples**   | How many observations were retained, and how many **gaps** there are (see [Gaps](#gaps-and-resets)). |

**Converting CPU peak to cores.** CPU is reported as CPU-milliseconds consumed per sample, and
SAM samples every 5 seconds by default (`RESOURCE_HISTORY_SAMPLE_INTERVAL`). One core running flat
out for a whole 5-second sample is 5,000 ms. So:

| CPU peak reads | Roughly           |
| -------------- | ----------------- |
| ~5,000 ms      | 1 core saturated  |
| ~10,000 ms     | 2 cores saturated |
| ~1,200 ms      | a quarter of one core |

If your deployment changed the sampling interval, divide by that interval in milliseconds instead.

### 2. The OOM banner

If the workspace was killed or throttled by the kernel for running out of memory, an amber banner
says so and counts the events. **This is the single most useful thing on the page** — an
out-of-memory kill is the usual explanation for an agent that stopped mid-sentence, produced a
truncated result, or reported a tool crash it could not describe.

If you see one, raise the memory the work asks for. See
[Right-sizing after you've read the history](#right-sizing-after-youve-read-the-history).

### 3. The detail timeline

The chart loads automatically for the most recent slice of the session:

- **Green solid line** — CPU, normalized to this slice's own CPU peak.
- **Purple dashed line** — RAM, normalized to this slice's own RAM peak.
- **Blue bands** — tool windows: stretches where the agent had one or more tool calls in flight.
  A fainter band means SAM inferred the end of the window rather than observing it.
- **An amber marker at the top**, with a dashed line down the chart — an out-of-memory sample.
- **A small grey dot at the bottom** — a gap or a counter reset. (These are easy to miss; see
  [Gaps and resets](#gaps-and-resets) for why they matter.)

Each line is scaled to its **own** peak within the slice, so the two lines are shaped for reading
against the tool bands — not against each other. A tall green line does not mean CPU is higher
than RAM.

Below the chart, **Tool windows** lists each window with its start time, duration, and how many
tool calls overlapped. Every entry currently reads `acp_tool_call`: SAM records that a tool ran,
not which one, so the list tells you _when_ and _how long_, never _what_. Under it, the I/O read
and write totals for this slice.

### 4. Chunks

SAM stores the history in slices ("chunks"), each covering a fixed stretch of time — 15 minutes by
default (`RESOURCE_HISTORY_CHUNK_INTERVAL`). The **N chunks** disclosure at the bottom is collapsed
until you open it; each row shows the start time, duration, sample count, stored size, tool-window
count, and gaps. Click one to load its timeline.

Only the chunk you select is fetched, so scrubbing back through a long session costs one small
request per slice rather than downloading everything up front. A very dense chunk is downsampled
before it is drawn — the header reads e.g. `720/2,400 points` — and the downsampling deliberately
preserves spikes, so a peak never disappears because a slice was long.

### Gaps and resets

A **gap** means SAM has no observations for a stretch — the node was rebooted, the agent restarted,
or telemetry could not be collected. A **counter reset** means the kernel counters the agent reads
went backwards, usually because the container was recreated.

Neither is an error. They matter because a gap is _not_ a period of zero usage: do not read a flat
line across a gap as "the agent was idle." The **Samples** stat card counts them, so when that card
says there were gaps, check the timeline for the grey dots before drawing conclusions from a quiet
stretch.

## What this does not tell you

Be precise about what the data can support, because the panel is easy to over-read:

- **It is not per-process attribution.** Samples come from the workspace's cgroup — the whole
  container, including the agent harness, your dev server, test runners, and background jobs. A
  tool window that overlaps a CPU spike is a *correlation*, not proof that the tool caused the spike.
- **It does not sample disk space.** Only disk *I/O* (bytes read and written). If you are chasing a
  "no space left on device" failure, this panel will not show it.
- **It does not explain what the agent was doing.** Tool windows are anonymous. SAM stores a hash
  of each tool-call ID, never the tool name, arguments, output, file paths, commands, or prompts.
  Pair the timeline with the chat transcript to work out the "what".

The drawer states the correlation caveat inline, under the chart, so nobody reads a chart in
isolation and reports a false cause.

## Where resource history exists — and where it doesn't

| Runtime                                       | Resource history |
| --------------------------------------------- | ---------------- |
| **VM-backed workspaces** (standard sessions and tasks) | Yes     |
| **[Instant sessions](/docs/guides/instant-sessions/)** (Cloudflare Containers) | No |
| **[App deployment](/docs/guides/app-deployments/) nodes**                      | No |

The collector runs in the VM agent when it holds the workspace role, which Instant containers do
not. Opening **Resources** on an Instant session shows _"No retained resource history is available
for this session yet."_ — that is the expected result, not a failure. The same message appears on a
brand-new VM session that has not yet finished its first chunk, so give a young session a few
minutes before concluding anything.

## How long it is kept

| Data                                        | Default retention | Setting                                     |
| ------------------------------------------- | ----------------- | ------------------------------------------- |
| Raw sample chunks (what the chart draws)    | 90 days           | `WORKSPACE_RESOURCE_RAW_RETENTION_DAYS`     |
| Session summaries (the stat cards)          | 180 days          | `WORKSPACE_RESOURCE_SUMMARY_RETENTION_DAYS` |

Summaries outlive the raw chunks on purpose: the cheap "what did this peak at" answer stays
available for six months, while the expensive per-sample detail expires first. Once the chunks
expire, the stat cards remain and the chart is empty.

Deleting a project or a workspace deletes its resource history with it. Self-hosters can tune every
value above — see [Configuration → Platform Limits](/docs/reference/configuration/#platform-limits).

## What is actually stored

The retained payload is deliberately narrow: timestamps, CPU-milliseconds, memory bytes, I/O bytes,
process counts, OOM flags, and hashed tool-call IDs with their start and end times.

It contains **no** prompts, messages, commands, tool names, tool arguments, tool output, file paths,
environment variables, or secrets. That is what makes it safe to keep for months and safe to hand to
an agent.

## Asking an agent to read it

Agents connected to SAM's MCP server can query the same data with the `get_resource_history` tool.
Give it a `projectId` plus one of `sessionId`, `taskId`, or `workspaceId`; add `chunkId` to pull the
samples for one slice. Without `chunkId` it returns only the summary and the chunk index, so a
casual lookup stays cheap.

This turns a vague complaint into a checkable one. For example:

> "Task `01M2…` failed near the end. Use `get_resource_history` for that task, tell me whether it
> hit an OOM, and if so what its RAM peak was."

The same information is available over HTTP at
`GET /api/projects/:projectId/sessions/:sessionId/resource-history` (also `…/tasks/:taskId/…` and
`…/workspaces/:workspaceId/…`), with an optional `?chunkId=` for detail.

## Right-sizing after you've read the history

The point of the panel is to make a machine-size decision with evidence instead of instinct.

**If you saw an OOM, or RAM peak sat near the machine's limit**, raise the memory floor. Requirements
resolve project → agent profile → skill → request, so set it at whichever level the problem belongs
to — the project default for "everything here needs more", the profile for "this agent is heavy".
Remember the host reserve: a 4 GiB machine can only back a ~3.5 GiB reservation, so asking for
exactly 4 GB pushes you onto an 8 GiB machine.

**If CPU peak never approached one core and RAM peaked far under the machine's size**, you are
paying for headroom you never used. Lower the requirement, or set the pool strategy to **Smallest
fit** so SAM stops reaching for big machines.

**If the timeline is mostly flat with long quiet stretches**, the session was waiting — on you, on
the network, on a provider — not computing. A bigger machine will not make it faster.

See [Compute Pools](/docs/guides/compute-pools/#resource-requirements-how-much-machine-work-asks-for) for where
each requirement is set and how SAM picks a machine from it.

## Troubleshooting

| What you see                                          | What it means                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| "No retained resource history is available"           | An Instant session (never collected), a VM session younger than its first chunk, or a session whose raw chunks have passed their retention.     |
| Stat cards present, chart empty                       | The raw chunks expired but the summary is still in retention. The peaks are still trustworthy; the per-sample detail is gone.                   |
| "Resource history could not be loaded."               | The request failed. Reopen the drawer; if it persists, [report it](/docs/guides/reporting-issues/) from the same rail.                          |
| A long flat stretch in the middle of a busy session   | Check for a gap marker. A gap is missing data, not idle time.                                                                                   |
| A tool window with no CPU or RAM movement under it    | The agent was waiting on something external — a network call, a provider, a human. Tool windows measure elapsed time, not work done.            |
| Tool windows drawn fainter than the rest              | The window's end was inferred (the session ended or the runtime went away before the call reported back), so treat its duration as approximate. |
