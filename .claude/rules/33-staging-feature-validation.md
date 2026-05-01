# Staging Feature Validation Methodology

## Why This Rule Exists

An agent was asked to validate recently deployed features (AI usage dashboard, budget controls, Anthropic proxy) using Playwright with two test users. It logged in as both users, confirmed pages loaded, confirmed API endpoints returned 200, and reported "all features validated." It never ran an agent session, never generated any AI Gateway usage data, never tested whether budget limits were enforced, and never verified that the usage dashboard displayed real numbers. Every "validation" was an existence check against empty state. The features could have been completely broken and the tests would have passed identically.

The root cause: the agent treated "validate" as "confirm the UI exists" because that's the cheapest interpretation. This rule encodes the methodology that prevents that failure mode — forcing the agent to think through what a real user would have done before reaching each feature, do those things, and verify the full chain.

## When This Applies

This rule applies when validating that deployed features actually work on staging or production. It applies to:
- Post-deploy feature validation
- Regression testing after significant changes
- Any task that asks to "test," "validate," or "verify" features on a live environment

## The Core Principle: Think Like a User, Not a Developer

A developer checks whether code exists. A user tries to accomplish something. Feature validation must follow the user's journey, not the code's structure.

**"Does the page load?" is not validation. "Can the user accomplish the thing the feature was built for?" is validation.**

## The Dependency Chain Method (Mandatory)

Before testing any feature, you MUST walk backwards through the user journey to identify every prerequisite. Then walk forwards, doing each step and validating it.

### Step 1: Identify What You're Validating

Read the recent git history, CLAUDE.md "Recent Changes" section, or the task description to identify which features need validation.

For each feature, write a one-sentence description of **what a user would accomplish** with it. Not what the code does — what the user does.

Examples:
- "User sees how many tokens their agents consumed this month, broken down by model"
- "User sets a daily token budget and gets blocked when they exceed it"
- "User submits a task and the agent completes it successfully"

### Step 2: Walk Backwards Through the User Journey

For each feature, ask: **"What must be true about this user's account for them to be at this point?"**

Work backwards from the feature to the beginning of the user's lifecycle:

```
Feature: "User sees token usage broken down by model"
  <- User must have usage data in AI Gateway
  <- Agents must have routed LLM calls through the AI proxy
  <- A workspace must have run an agent session
  <- A task must have been submitted
  <- A project must exist with a connected repo
  <- The user must be logged in with credentials configured
```

Each line is both a prerequisite AND something that should work correctly. Write out this full chain before doing anything.

**Reusing existing state:** If staging already has data from previous testing (existing projects, nodes, tasks), you MAY skip prerequisite steps that are already satisfied — but you MUST verify the existing state is valid and current before relying on it. Check that existing projects still exist, nodes are healthy, and data was created by the current code version. Stale data from a previous deploy does not validate current features.

### Step 3: Walk Forwards, Validating Every Step

Starting from the first prerequisite, execute each step as a real user would. At each step:

1. **Do the action** — click the button, fill the form, submit the request
2. **Validate the immediate result** — did it succeed? Is the response correct? Is the UI state right?
3. **Validate the side effects** — did the data persist? Did the downstream system receive what it should?
4. **Screenshot the evidence** — capture the state for the validation report

If ANY step in a chain fails, stop that chain and report the failure. Do not skip ahead to test later steps — the dependency chain means later steps cannot produce valid results if earlier steps are broken.

If you are validating multiple independent features, a failure in one feature's chain does not block validation of unrelated features. Continue with other features and report all results together.

### Step 4: Validate the Target Feature

Only after all prerequisites are satisfied and validated, test the actual feature:

1. Navigate to the feature as a user would (not by directly entering the URL)
2. Exercise every interaction the feature offers
3. Verify the data displayed is consistent with what you created in the prerequisite steps
4. Test edge cases: empty state, error handling, boundary values

## What Valid Test Data Means

Features that display data are meaningless to test against empty state. **You must create the data the feature is designed to show.**

| Feature | Required Data | How to Create It |
|---------|--------------|------------------|
| AI usage dashboard | Real AI Gateway logs with token counts | Run agent sessions that make LLM calls through the proxy |
| Budget controls | Usage approaching or exceeding a limit | Set a low limit, then run agent work that generates tokens |
| Cost monitoring | Per-model, per-user cost data | Run sessions using different models |
| Task management | Tasks in various states | Submit tasks, let some complete, cancel others |
| Project chat | Chat messages with tool calls | Have a conversation with an agent in a project |
| Knowledge graph | Entity-observation-relation data | Run an agent that uses knowledge tools |

If the feature you're testing doesn't appear in this table, apply the same principle: identify what data the feature needs, then create that data through the normal user path.

## Multi-User Validation

When two test users are available (via `SAM_PLAYWRIGHT_PRIMARY_USER` and `SAM_PLAYWRIGHT_SECONDARY_USER` env vars), validate multi-tenant isolation:

1. Create data as User A (primary)
2. Log in as User B (secondary)
3. Verify User B cannot see User A's data
4. Verify User B's features work independently

If the secondary user env var is not set, document that multi-tenant validation was skipped and why.

## What Is NOT Validation

The following do NOT count as feature validation:

- Confirming a page loads without errors
- Confirming an API endpoint returns 200
- Confirming a UI component renders
- Confirming navigation works
- Checking that no console errors appear
- Running curl against an API endpoint
- Reading the code and concluding it looks correct
- Checking that a settings/config endpoint returns the right value without testing the feature the setting controls
- Verifying you can save a setting (write path) without verifying it's enforced (read path)
- Testing against data that already existed on staging from a previous deploy without verifying it reflects current code

These are regression baseline checks. They are necessary but they prove nothing about whether features work. See also Rule 13 ("What Is NOT Acceptable as Feature Verification") and Rule 30 ("Anti-Rationalization Rules") for the full list of banned shortcuts.

## Validation Report Format

After completing validation, report:

```markdown
## Feature Validation Report

### Features Tested
1. [Feature name] — [one-line description of what was tested]

### Prerequisite Chain
- [x] Step 1: [what was done] — [result]
- [x] Step 2: [what was done] — [result]
- [ ] Step N: [what failed] — [error/issue]

### Feature Results
| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| [name] | PASS/FAIL | [screenshot path or description] | [details] |

### Issues Found
- [SEVERITY] [description] — [steps to reproduce]

### Data Created During Testing
- [list of test resources created that may need cleanup]
```

## Cleanup Obligations

After validation is complete, delete test resources you created (workspaces, nodes, test projects) unless they are needed for future testing. See Rule 13: "delete test workspaces/nodes after verification."

## Dispatching Feature Validation (Mandatory)

When any agent is asked to validate, test, or verify features on a live environment (staging or production), it MUST dispatch a task to the `staging-validator` agent profile. The agent MUST NOT perform the validation itself with shallow checks.

This applies to:
- Any explicit request to "test the features," "validate the deploy," or "verify things work"
- Post-deploy validation across multiple features
- Post-merge production verification when deep feature validation is requested

The implementing agent has an inherent bias toward confirming its own work — a separate validator agent does not.

### Relationship with Rule 13 (Staging Verification)

Rule 13 defines the implementing agent's PR-scoped staging verification — deploy, authenticate, run the regression checklist, verify the specific PR's changes. That remains the implementing agent's responsibility.

This rule (33) applies when deeper, user-journey-based validation is needed — especially when validating multiple features or when the user explicitly asks for thorough testing. The `staging-validator` profile is the agent that does this work. It supplements Rule 13; it does not replace it.

### How to Dispatch

```
Validate the following features on staging as a real user would.

Features to validate:
- [feature 1: one-line description of what the user should be able to accomplish]
- [feature 2: ...]

Environment: staging (app.sammy.party)

For each feature, walk backwards through the user journey to identify all prerequisite steps. Then walk forwards, executing each step and validating the result before moving on. Create real data where needed — do not test data-display features against empty state.

Read .claude/rules/33-staging-feature-validation.md for the full methodology.
```

### What to Include in the Dispatch

1. Which features to validate (or "all features deployed in the last N hours") — described as **user outcomes**, not code changes
2. Which environment (staging or production)
3. Any specific user journeys to prioritize
4. Any known prerequisites that are already in place (e.g., "staging already has projects and nodes from previous testing")
