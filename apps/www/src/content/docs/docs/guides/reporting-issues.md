---
title: Reporting Issues
description: Report a problem from inside SAM, choose what technical context to attach, and — for operators — configure where reports land and how errors are triaged automatically.
---

When SAM misbehaves, you can report it without leaving the app. This page covers the reporting flow for everyday users, then the operator-side setup that makes it work.

## Reporting a problem

There are two ways in.

### From a chat session

Use this when an agent did something wrong — got stuck, produced bad output, lost its work, failed to start.

The **Report** action lives in the session header's expanded detail panel, so open that first:

1. In the chat, click the chevron at the right of the session header (**Show session details**).
2. In the action row that appears, click **Report** (the flag icon).

That row also has **Files**, **Git**, and **Workspace** while the session is live; those disappear once it stops or fails. **Report** and **Timeline** stay put — so you can still report a session that already ended, which is usually when you want to.

![The Report an Issue dialog in SAM: a Title field, a Description field, and a checked "Attach technical references to help diagnose this issue" checkbox listing a Chat session, Task, and Node identifier.](/images/docs/report-issue-dialog.png)

_Shown with the consent box ticked so the identifier list is visible. It is unchecked by default._

### From a crash screen

If the UI itself crashes, the error screen offers a **Report this issue** link. Use this when a page went blank or threw an error rather than the agent misbehaving.

Either way you get the same dialog: a **title**, a **description**, and — when SAM has context to offer — a consent checkbox.

## What gets attached, and only if you say so

SAM never attaches technical context silently. The dialog shows an unchecked box:

> **Attach technical references to help diagnose this issue**

Tick it and SAM lists the exact identifiers it would send, so you can see them before you submit:

| Reference        | Where it comes from                      | Checked against your access? |
| ---------------- | ---------------------------------------- | ---------------------------- |
| **Chat session** | The session you're reporting from        | Yes — must be your workspace |
| **Task**         | The task backing that session            | Yes — must be your project   |
| **Node**         | The machine the workspace was running on | Yes — must be your node      |
| **Error**        | The crash screen's error text            | No — see below               |

Reporting from a chat session offers the first three; the crash screen offers the error reference. (The API also accepts a **Diagnosis** reference for a superadmin deployment diagnosis, but no screen currently supplies one.)

These are **identifiers only** — SAM does not ship your code, your transcript, or your environment. They let a maintainer look up the right records rather than guess from a description.

The **Error** reference is the odd one out. It is taken from the crash text your browser produced, but the server only accepts identifier-shaped values — letters, digits, and `.` `_` `:` `-`, with no spaces. Most real error messages contain spaces or punctuation, so in practice this reference is usually dropped rather than attached. Describe the error in your own words; don't count on it coming along.

Leave the box unchecked and only your title and description are submitted. The report still gets filed.

Two things happen server-side regardless of what you tick:

- **Ownership is re-checked.** Session, task, node, and diagnosis references are verified against your access before they're stored, and silently dropped if you don't have it — a stale or copied identifier can't pull someone else's records into your report. The **error** reference is not looked up, because it isn't a pointer to a stored record. The confirmation screen lists what was actually attached, which may be fewer references than the dialog offered — and lists none at all if everything was dropped.
- **Everything is scrubbed** — your title, your description, and each attached reference. Best-effort redaction strips credential-shaped strings (API keys, tokens, `sk-`/`ghp_`-style prefixes, PEM private key blocks) and email addresses before anything is stored, so a secret that leaked into an error message doesn't ride along. Treat it as a safety net, not a licence — don't paste secrets into the box.

## After you submit

You get a confirmation with a **report ID**, a status of `draft`, and the list of references that were actually attached. The report becomes a **draft [Idea](/docs/guides/idea-execution/)** in the platform's feedback project, where a maintainer picks it up.

Reports are rate-limited to **20 per hour** per account (`RATE_LIMIT_REPORT_ISSUE_POST`). Exceeding that returns a `429`. The window is a fixed clock hour rather than a rolling sixty minutes, so the allowance resets at the top of the next hour — which may be in five minutes or fifty-five.

Length limits: title **200** characters, description **5,000** characters. The dialog enforces both as you type, so you'll notice the cap rather than lose text on submit.

## Don't see a Report button?

The feature is **hidden entirely** unless the deployment has been configured with a feedback project. If neither entry point appears, this deployment hasn't set one up — report through whatever channel your operator uses instead. On a self-hosted SAM, that operator is you; see below.

---

## For operators: where reports land

Reports are filed as draft Ideas in one project you nominate:

```
PLATFORM_FEEDBACK_PROJECT_ID=<project id>
```

Set it to a project that exists in **this deployment's** database. SAM validates the project on every check — if the variable is unset, or points at a project that doesn't exist, `GET /api/report-issue/config` returns `enabled: false` and both entry points disappear from the UI. This is deliberate: an unconfigured deployment shows no button rather than a button that errors.

The same project also receives [automated error triage](#for-operators-automated-error-triage), so pick one you'll actually watch — a dedicated "Platform Feedback" project works well.

### Report limits

| Variable                              | Default | Description                                                             |
| ------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `PLATFORM_FEEDBACK_PROJECT_ID`        | unset   | Project that receives reports and triage Ideas. Unset ⇒ feature hidden. |
| `REPORT_ISSUE_TITLE_MAX_LENGTH`       | `200`   | Truncation ceiling for the stored title — see below                     |
| `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH` | `5000`  | Truncation ceiling for the stored description — see below               |
| `REPORT_ISSUE_CONTENT_MAX_LENGTH`     | `65536` | Max stored Idea body, including attached references                     |
| `RATE_LIMIT_REPORT_ISSUE_POST`        | `20`    | Report submissions allowed per clock hour, per user                     |

:::caution
The two length variables can only **lower** the stored length — they cannot raise the limit users hit. The request schema and the dialog both enforce the built-in 200 / 5,000 caps, so `REPORT_ISSUE_DESCRIPTION_MAX_LENGTH=20000` still rejects a 5,001-character description with a `400`. Set them below the defaults to truncate more aggressively; setting them above has no effect.
:::

### How a report is stored

Every report Idea is written in a three-part structure that keeps maintainer instructions separate from user-supplied text:

| Section                                          | Contents                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `## Maintainer Instructions`                     | SAM's own triage instructions, plus an explicit security boundary statement |
| `## Trusted Metadata`                            | The identifiers the reporter consented to attach, one per line              |
| `## Untrusted Evidence: User Report Description` | The reporter's own words, redacted and wrapped in a Markdown code fence     |

That fence matters when you point an agent at the resulting Idea. The reporter's description is external input, and treating it as instructions would be a prompt-injection channel straight into a maintainer's agent. The format tells the agent explicitly which parts are yours and which are the reporter's. SAM's default "execute idea" prompt template carries the same warning; if you override it with `VITE_EXECUTE_IDEA_PROMPT_TEMPLATE`, keep that instruction.

## For operators: automated error triage

Beyond user-submitted reports, SAM files its **own** reports. Once an hour it groups recent platform errors, runs the [deployment diagnosis agent](#for-superadmins-diagnosing-errors-with-an-agent) on a representative error from each group, and writes a draft Idea into the same feedback project.

Grouping is by a redacted content signature, so a recurring error updates its existing Idea instead of filing a new one every hour. A group that fails triage repeatedly is rejected rather than retried forever.

There is no UI button for triage yet. A superadmin can `POST /api/admin/observability/feedback-triage` to sweep immediately rather than waiting for the next hourly run. Note that a manual sweep still only looks back over `PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES` (60 minutes by default), so it will not surface older errors — to test a fresh configuration, trigger it while a recent error is still inside that window.

| Variable                                             | Default  | Description                                          |
| ---------------------------------------------------- | -------- | ---------------------------------------------------- |
| `PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES`            | `60`     | Lookback window for grouping recent errors           |
| `PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT`               | `100`    | Max error rows scanned per sweep                     |
| `PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT`               | `5`      | Max grouped candidates processed per sweep           |
| `PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT`            | `10`     | Max error references retained per group              |
| `PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS`              | `600000` | Claim lease before a later sweep can reclaim a group |
| `PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES`              | `3`      | Failed attempts before a group is rejected           |
| `PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH` | `240`    | Max characters stored for a sanitized failure reason |

Automated triage and superadmin-initiated diagnosis have **separate** daily token budgets. They read the same `DEBUG_AGENT_DAILY_TOKEN_LIMIT` value but count against independent per-feature counters, so a noisy hour of triage can never eat the allowance a superadmin wants for hands-on diagnosis. Budget accordingly: with triage enabled, worst-case daily spend on diagnosis is **twice** `DEBUG_AGENT_DAILY_TOKEN_LIMIT`. To cap triage specifically, lower `PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT` or `PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT`.

## For superadmins: diagnosing errors with an agent

**Admin → Errors** can hand an error to an AI agent for analysis.

- **Diagnose** on a single error row — analyze one specific failure.
- **Diagnose window** — analyze everything in the current filter. Windows longer than 24 hours are clamped, and the button relabels itself **Diagnose latest 24h** so you know what you're actually getting.

The agent reads bounded, redacted evidence — recent errors, a health summary, error trends, Worker logs, and related entity state — and returns a written analysis. The panel shows the model, turn count, tokens for that run, and your usage against the daily budget.

Diagnosis runs are **durable**. Starting one returns immediately and the work continues server-side, so closing the tab doesn't kill it. A **Recent diagnosis runs** card lists the last several runs with their status (`queued`, `running`, `succeeded`, `failed`); an in-flight run is marked recoverable after refresh, and a failed one gets a **Retry** button.

When a diagnosis is worth keeping, **Save as draft Idea** files it into a project you choose so it becomes tracked work instead of a panel you have to leave open.

### What the agent is not allowed to see

`/admin/errors` is superadmin-only and its raw rows can contain local user IDs, IP addresses, and user-agent strings. Before any tool result reaches the model, SAM recursively strips those fields plus credential-shaped values — API tokens, JWTs, authorization headers, private keys, and long secret-like strings. Cloudflare credentials stay server-side and never enter model messages or saved diagnosis text.

The same redactor now also runs on the **Worker log query** behind `/admin/logs`, over each entry's `details` object. So a superadmin browsing logs directly will see `[REDACTED]` in place of values — including `user_id`, `ip_address`, and `user_agent`, which are correlation fields rather than secrets. That is expected, not a bug. It does not cover an entry's `message` text, so treat log messages as unredacted.

### Diagnosis limits

| Variable                          | Default               | Description                                                                                      |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `DEBUG_AGENT_MODEL`               | `@cf/zai-org/glm-5.2` | Workers AI model used for diagnosis                                                              |
| `DEBUG_AGENT_MAX_TURNS`           | `6`                   | Max model/tool turns per diagnosis                                                               |
| `DEBUG_AGENT_RUN_TOKEN_LIMIT`     | `24000`               | Combined token ceiling per diagnosis                                                             |
| `DEBUG_AGENT_MODEL_OUTPUT_TOKENS` | `4096`                | Max output tokens per model turn                                                                 |
| `DEBUG_AGENT_DAILY_TOKEN_LIMIT`   | `120000`              | Daily budget, counted **per feature** — manual diagnosis and automated triage each get this much |
| `DEBUG_AGENT_TOOL_RESULT_LIMIT`   | `50`                  | Max rows returned by a diagnosis tool                                                            |
| `DEBUG_AGENT_TOOL_RESULT_BYTES`   | `32768`               | Max serialized bytes per model-visible result                                                    |
| `DEBUG_AGENT_MAX_WINDOW_HOURS`    | `24`                  | Max selectable diagnosis window                                                                  |
| `DEBUG_AGENT_TIMEOUT_MS`          | `120000`              | Timeout per diagnosis model request                                                              |
| `DEBUG_AGENT_HARD_DEADLINE_MS`    | `900000`              | Hard deadline after which an active diagnosis is terminalized                                    |
| `DEBUG_AGENT_STALE_HEARTBEAT_MS`  | `120000`              | Stale heartbeat threshold used by the orphan reconciler                                          |
| `DEBUG_AGENT_RETRY_BASE_DELAY_MS` | `2000`                | Initial classified transient retry delay                                                         |
| `DEBUG_AGENT_RETRY_MAX_DELAY_MS`  | `60000`               | Maximum classified transient retry delay                                                         |
| `DEBUG_AGENT_STEP_MAX_RETRIES`    | `3`                   | Maximum transient retries for one checkpointed step                                              |

Exhausting the daily budget does not block the request up front — the run is accepted, then fails with **"Daily deployment debugging budget exhausted"** and appears in **Recent diagnosis runs** as `failed`. Its **Retry** button will keep failing until the next day.

See the [Configuration Reference](/docs/reference/configuration/) for the complete variable list.
