---
description: End-to-end task execution — research, plan, implement, review, and merge via PR
argument-hint: <task description>
---

## User Input

```text
$ARGUMENTS
```

You are an autonomous task executor. The user has described a task above. Your job is to take it from idea to merged PR with zero hand-holding. Follow every phase below in order.

---

## Phase 0: Initialize Workflow Tracker (MANDATORY FIRST STEP)

**Before doing ANYTHING else**, {{#if workflow.trackingTool == "TodoWrite"}}create a TodoWrite with all phases of this workflow{{else}}{{#if workflow.trackingTool == "TaskCreate"}}create tasks for each phase{{else}}create a markdown checklist in `{{workflow.stateFile}}`{{/if}}{{/if}}. This tracking survives context compaction and ensures no phase is skipped even if the conversation is continued in a new session.

{{#if workflow.trackingTool == "TodoWrite"}}
```
TodoWrite([
  { content: "Phase 1: Research & task creation", status: "pending", activeForm: "Researching codebase and creating task file" },
  { content: "Phase 2: Worktree setup", status: "pending", activeForm: "Setting up worktree and feature branch" },
  { content: "Phase 3: Implementation", status: "pending", activeForm: "Implementing changes" },
  { content: "Phase 4: Pre-PR validation (lint, typecheck, test, build)", status: "pending", activeForm: "Running full quality suite" },
  { content: "Phase 5: Review (specialist validation)", status: "pending", activeForm: "Running reviewers" },
  {{#if phases.staging.enabled}}{ content: "Phase 6: Staging verification", status: "pending", activeForm: "Verifying on staging" },{{/if}}
  { content: "Phase 7: Create PR, wait for CI, merge", status: "pending", activeForm: "Creating and merging PR" },
])
```
{{/if}}

You may add sub-tasks for implementation details, but these phase-level items MUST remain in the tracking system at all times. Mark each phase as `completed` only when ALL of its steps are done.

Also create `{{workflow.stateFile}}` in the repo root (gitignored) as a complementary external memory file. See project-specific persistence rules for the full spec. Re-read it at every phase boundary.

---

## Phase 1: Research & Task Creation

1. **Understand the request.** Parse the user input to identify:
   - What needs to change (feature, bug fix, refactor, etc.)
   - Which parts of the codebase are likely affected
   - Any constraints or preferences stated

2. **Research the codebase.** Before writing anything:
   - Search and read to find all relevant code paths
   {{#if project.docsPath}}- Read related public docs in `{{project.docsPath}}/`{{/if}}
   {{#if project.specsPath}}- Review specifications in `{{project.specsPath}}/`{{/if}}
   {{#if project.rulesPath}}- Check project rules in `{{project.rulesPath}}/`{{/if}}
   {{#if phases.research.postMortemPaths}}- **Review relevant post-mortems** in {{#each phases.research.postMortemPaths}}`{{this}}/`{{#unless @last}}, {{/unless}}{{/each}}. Search for post-mortems that touch the same subsystems, patterns, or failure modes. Read "What broke", "Root cause", and "Process fix" sections.{{/if}}
   - Use web search for external library/API docs if needed
   - Identify existing patterns, conventions, and test approaches

3. **Create a task file** in `{{project.taskPaths.backlog}}/` using the format `YYYY-MM-DD-descriptive-name.md`:
   - Problem statement (what and why)
   - Research findings (key files, patterns, dependencies discovered)
   - Detailed checklist of implementation steps
   - Acceptance criteria
   - References to relevant docs, specs, or rules

{{#if workflow.gitWorkflow.taskCommitToMain}}
4. **Commit and push the task file directly to `{{workflow.gitWorkflow.mainBranch}}`:**
   ```
   git add {{project.taskPaths.backlog}}/<file>.md
   git commit -m "task: add <descriptive-name>"
   git push origin {{workflow.gitWorkflow.mainBranch}}
   ```

> **IMPORTANT**: Only the task file goes to {{workflow.gitWorkflow.mainBranch}}. All implementation work goes on a feature branch.
{{/if}}

---

## Phase 2: Worktree Setup

1. **Create a feature branch and worktree:**
   ```
   git worktree add {{workflow.gitWorkflow.worktreePrefix}}-<short-name> -b {{workflow.gitWorkflow.branchPrefix}}<branch-name>
   ```
   - Branch naming: use a descriptive kebab-case name
   - Worktree location: relative to the main repo directory

2. **Move the task file** from `{{project.taskPaths.backlog}}/` to `{{project.taskPaths.active}}/` in the worktree and commit.

3. **Install dependencies** in the worktree (adjust command based on your project's package manager).

4. **Verify the starting state** — run quality checks to confirm a clean baseline.

---

## Phase 3: Implementation

Execute the checklist from the task file. Follow these rules:

1. **Work through checklist items sequentially**, checking each off in the task file as you complete it.

2. **Follow project conventions:**
   {{#if project.rulesPath}}- Obey all rules in `{{project.rulesPath}}/`{{/if}}
   {{#if phases.implementation.buildOrder}}- Respect build order: {{#each phases.implementation.buildOrder}}{{this}}{{#unless @last}} -> {{/unless}}{{/each}}{{/if}}
   {{#if conventions.documentationSync}}- Update documentation in the same commit as code changes{{/if}}
   - Write tests that prove the feature works
   {{#if conventions.noHardcodedValues}}- No hardcoded values{{/if}}

3. **Push frequently.** After every meaningful unit of work:
   ```
   git add <specific-files>
   git commit -m "<type>: <description>"
   git push origin <branch-name>
   ```

4. **Run quality checks regularly** during implementation:
   {{#if phases.implementation.qualityCommands.typecheck}}- `{{phases.implementation.qualityCommands.typecheck}}` after type-related changes{{/if}}
   {{#if phases.implementation.qualityCommands.lint}}- `{{phases.implementation.qualityCommands.lint}}` after any code changes{{/if}}
   {{#if phases.implementation.qualityCommands.test}}- `{{phases.implementation.qualityCommands.test}}` after adding/modifying tests{{/if}}

5. **Update `{{workflow.stateFile}}`** after every commit — check off completed implementation items and add notes.

---

> **Checkpoint (MANDATORY)**: Re-read `{{workflow.stateFile}}` AND the task file. Walk through every acceptance criterion and confirm it's met. Only proceed once you've verified completeness.

## Phase 4: Pre-PR Validation

Before creating the PR, ensure everything is solid:

1. **Run the full quality suite:**
   ```
   {{phases.implementation.qualityCommands.lint}} && {{phases.implementation.qualityCommands.typecheck}} && {{phases.implementation.qualityCommands.test}}{{#if phases.implementation.qualityCommands.build}} && {{phases.implementation.qualityCommands.build}}{{/if}}
   ```
   Fix any failures before proceeding.

2. **Verify documentation sync** — grep for references to anything you changed and update stale docs.

3. **Move the task file** from `{{project.taskPaths.active}}/` to `{{project.taskPaths.archive}}/` and commit.

---

## Phase 5: Review

{{#if phases.review.enabled}}
Run validation based on what the PR touches:

| PR touches | Reviewer | What it checks |
|------------|----------|----------------|
{{#each phases.review.reviewers}}
| {{#if trigger.always}}**Always**{{else}}{{#each trigger.paths}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}} | `{{#if skill}}{{skill}}{{else if agent}}{{agent}}{{else}}{{name}}{{/if}}` | {{checks}} |
{{/each}}

Address every bug or correctness issue raised. Push fixes and re-run quality checks.

**HARD STOP: Wait for ALL reviewers to complete before proceeding.** Update `{{workflow.stateFile}}` with reviewer status (PENDING/PASS/ADDRESSED). Phase 5 CANNOT be marked complete until every reviewer shows `PASS` or `ADDRESSED`.

{{else}}
This project has review disabled. Proceed to Phase 6.
{{/if}}

---

{{#if phases.staging.enabled}}
## Phase 6: Staging Verification ({{#if phases.staging.required}}BLOCKING{{else}}OPTIONAL{{/if}})

{{#if phases.staging.required}}
> **Checkpoint**: Before entering Phase 6, re-read `{{workflow.stateFile}}` and verify all reviewers completed.
{{/if}}

If this PR includes **any code changes** (not just docs/tasks), {{#if phases.staging.required}}deploy to staging and verify before creating the PR{{else}}consider deploying to staging for verification{{/if}}.

### 6a. Standard Verification

{{#if phases.staging.deployment.checkCommand}}
1. **Check for existing staging deployments:**
   ```bash
   {{phases.staging.deployment.checkCommand}}
   ```
   Wait if active deployments are in progress.
{{/if}}

{{#if phases.staging.deployment.triggerCommand}}
2. **Deploy to staging:**
   ```bash
   {{phases.staging.deployment.triggerCommand}}
   ```
   {{#if phases.staging.deployment.watchCommand}}
   Then watch for completion:
   ```bash
   {{phases.staging.deployment.watchCommand}}
   ```
   {{/if}}
{{/if}}

3. **Open the live app** {{#if phases.staging.environment.appUrl}}at `{{phases.staging.environment.appUrl}}`{{/if}}.

{{#if phases.staging.environment.authMethod == "token"}}
4. **Authenticate** using the appropriate method for your environment.
{{/if}}

5. **Verify the changed behavior works end-to-end:**
   - **UI changes**: interact as a real user — click buttons, submit forms, navigate pages
   - **API/backend changes**: verify affected endpoints respond correctly

6. **Report findings** with evidence (screenshots or observations).

7. **If issues are found**, fix them, push, re-deploy, and re-verify.

{{#if phases.staging.infrastructure.required}}
### 6b. Infrastructure Verification

{{#if phases.staging.infrastructure.triggers}}
If the PR touches **any** of: {{#each phases.staging.infrastructure.triggers}}{{this}}{{#unless @last}}, {{/unless}}{{/each}} — you MUST verify infrastructure provisioning works end-to-end.

This verification is not optional. Follow project-specific infrastructure verification procedures.
{{/if}}
{{/if}}

{{else}}
## Phase 6: Staging Verification

Staging verification is disabled for this project. Proceed to Phase 7.
{{/if}}

---

## Phase 7: Pull Request & Merge

1. **Create the PR**:
   - Title: short, under 70 characters
   - Body: {{#if phases.pr.template}}use the PR template from `{{phases.pr.template}}`{{else}}include summary, testing notes, and checklist{{/if}}

2. **Push and wait for CI.** Check for CI failures and fix if needed.

3. **Once CI is fully green**, merge the PR{{#if phases.pr.mergeMethod}} using `{{phases.pr.mergeMethod}}` method{{/if}}.

4. **Clean up the worktree:**
   ```
   cd <main-repo-directory>
   git worktree remove <worktree-path>
   ```

5. **Pull {{workflow.gitWorkflow.mainBranch}}** to stay current:
   ```
   git pull origin {{workflow.gitWorkflow.mainBranch}}
   ```

{{#if phases.pr.monitorDeploy}}
### 7b. Post-Merge Production Deploy Monitoring (MANDATORY)

After merging to {{workflow.gitWorkflow.mainBranch}}, monitor the production deployment to completion.

1. **Wait for the deploy workflow to start** and watch it to completion.

2. **If the deploy succeeds**: Report success to the user.

3. **If the deploy FAILS**: 
   - Immediately inspect the failure
   - **Alert the user immediately** with the failure reason
   - Fix if it's a code issue, or explain what manual intervention is needed
{{/if}}

7. **Delete `{{workflow.stateFile}}`** — the workflow is complete.

---

## Guiding Principles

- **Autonomy**: Complete the entire flow without asking unless genuinely blocked.
- **Transparency**: Report progress at each phase transition.
- **Safety**: Push often, never force-push{{#if workflow.gitWorkflow.taskCommitToMain}}, never commit to {{workflow.gitWorkflow.mainBranch}} (except the task file){{/if}}.
- **Quality**: Every shortcut now is a bug later. Follow the rules.
- **Iteration**: Review feedback is not optional — address it all.
{{#if phases.pr.monitorDeploy}}- **Deploy awareness**: A merged PR is not shipped until the deploy succeeds. Monitor it.{{/if}}
