# Error Messages Rendered as Unsanitized Markdown in Chat

## Problem

When a task fails, the full devcontainer build log is displayed in the chat message area and is rendered as markdown. This causes docker build output to be misinterpreted:
- `#` characters in build step numbers (e.g., `Step 1/23 :`) create markdown headings
- URLs in log output become clickable links
- `*` characters in grep patterns (e.g., `'^root|^[^:]*:[^:]*:root:'`) create italic/bold formatting
- The overall result is an unreadable wall of misformatted text

## Visual Impact

The error messages are extremely long (hundreds of lines of docker build output) and visually chaotic. Users see a mix of giant headings, random italic text, and clickable links embedded in build logs, making it nearly impossible to find the actual error.

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Medium — error messages are present but unreadable
- **Screenshots**: `.codex/tmp/playwright-screenshots/task-failure-error.png`

## Two Separate Issues

### 1. Error messages should be displayed as preformatted text
System error messages (especially build logs) should be wrapped in `<pre>` or code blocks, not rendered as markdown prose.

### 2. Error messages are too verbose
The full docker build log (all 23 build steps, layer pull progress, etc.) is dumped into the chat. Users need:
- A concise summary: "Devcontainer build failed: Could not resolve host: github.com"
- An expandable/collapsible section for the full log (for debugging)

## Acceptance Criteria

- [ ] System error messages in chat are rendered as preformatted/monospace text (not markdown)
- [ ] Error messages show a concise summary first (extract the actual error from the build log)
- [ ] Full build log is available via expandable "Show details" section
- [ ] Markdown-interpreted characters in error messages do not create visual artifacts
