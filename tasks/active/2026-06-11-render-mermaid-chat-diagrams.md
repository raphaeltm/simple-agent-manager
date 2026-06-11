# Render Mermaid Diagrams in Project Chat

## Problem

Project chat renders fenced `mermaid` code blocks as syntax-highlighted code instead of diagrams. Agents frequently use Mermaid for architecture, control flow, state machines, and dependency explanations, so project chat needs to render completed Mermaid blocks as inspectable diagrams without breaking streaming messages, persisted history, mobile layouts, or existing markdown behavior.

## Research Findings

- Idea `01KTV5F273DAC9VV592W9ZB5DD` describes the required behavior: render Mermaid in the real ACP-backed chat path, support streamed/finalized messages safely, preserve markdown behavior, and provide an expanded diagram view with pan/zoom/reset.
- Project chat flows through `apps/web/src/components/project-message-view/AcpConversationItemView.tsx` into `@simple-agent-manager/acp-client` `MessageBubble`.
- `packages/acp-client/src/components/MessageBubble.tsx` renders markdown with `react-markdown`, `remark-gfm`, and `prism-react-renderer`; `language-mermaid` currently follows the generic highlighted-code path.
- `packages/acp-client/src/components/TypewriterText.tsx` accepts the same markdown component override map, so Mermaid support must be wired through the shared ACP markdown component factory.
- `apps/web/src/components/MarkdownRenderer.tsx` already has a hardened Mermaid renderer: `securityLevel: 'strict'`, DOMPurify sanitization, explicit SVG allowlists, `foreignObject` allowances needed for Mermaid v11 flowchart labels, and `<pre>` unwrapping.
- `apps/www/src/scripts/blog-mermaid.ts` has pan/zoom/fullscreen behavior, but it is page-script-specific and uses blog chrome/theme assumptions. Reuse interaction ideas, not the script directly.
- Archived security tasks `tasks/archive/2026-03-23-fix-mermaid-xss.md` and `tasks/archive/2026-05-28-mermaid-foreignobject-text-fix.md` document prior Mermaid XSS and invisible-label fixes. The chat implementation must preserve strict Mermaid initialization, SVG sanitization, and safe `foreignObject` support.
- `apps/web/tests/playwright/markdown-chat-rendering-audit.spec.ts` already exercises the real project chat markdown path with mocked messages and no-auth Playwright setup. It is the right place to add visual coverage for Mermaid blocks.
- Stored project knowledge says Raphaël primarily uses SAM from the mobile PWA and often finds horizontal scrolling bugs, so mobile overflow and fullscreen touch behavior are primary acceptance criteria.

## Implementation Checklist

- [ ] Add Mermaid rendering support in `packages/acp-client`, with lazy Mermaid initialization and DOMPurify SVG sanitization owned by the package.
- [ ] Reuse/adapt the app renderer's strict Mermaid theme and explicit sanitizer policy, including safe Mermaid v11 `foreignObject` label support and XSS-stripping tests.
- [ ] Route `language-mermaid` code blocks in `MessageBubble` to the Mermaid renderer while preserving non-Mermaid highlighting, language-less multiline `<pre>` blocks, and inline code.
- [ ] Implement conservative streaming behavior: while `streaming` or animated reveal is active, Mermaid fences render as code/fallback; finalized messages render diagrams.
- [ ] Add embedded diagram chrome with accessible icon buttons for expand, reset, and copy source.
- [ ] Add a fixed fullscreen overlay with Escape close, focus return, reset, copy source, pointer/touch pan, wheel/pinch zoom, and mobile-safe layout.
- [ ] Add graceful error state for invalid Mermaid that does not crash the message and allows copying/viewing source.
- [ ] Add unit tests for Mermaid rendering, error handling, `<pre>` unwrapping, streaming deferral, non-Mermaid code regressions, inline code, language-less code, and SVG sanitization.
- [ ] Add/extend Playwright visual audit coverage through the real project chat route for normal, long/wide, invalid, and fullscreen Mermaid diagrams on mobile and desktop.
- [ ] Run package/app quality checks and required Playwright visual audit; inspect screenshots for nonblank SVGs, no viewport overflow, usable controls, and fullscreen behavior.
- [ ] Run specialist review before PR: `task-completion-validator`, `ui-ux-specialist`, `security-auditor`, `constitution-validator`, and `test-engineer`.

## Acceptance Criteria

- [ ] A completed project chat message with a valid fenced `mermaid` block renders a sanitized SVG diagram, not highlighted source.
- [ ] Streaming/incomplete Mermaid does not show transient parser errors, repeatedly churn expensive renders, or destabilize layout.
- [ ] Fullscreen/expanded mode supports pan, zoom, reset, copy source, Escape close, close button, mobile touch use, and focus return.
- [ ] Invalid diagrams fail gracefully with a compact error state and access to source.
- [ ] Existing markdown behavior for file links, tables, lists, task lists, code blocks, inline code, TTS actions, animated text, and message styling remains intact.
- [ ] SVG sanitization strips scripts, event handlers, dangerous URLs, and unsafe HTML while preserving legitimate Mermaid v11 labels.
- [ ] Playwright screenshots verify mobile and desktop project chat have no horizontal viewport overflow, nonblank diagrams, and usable fullscreen controls.

## References

- Idea: `01KTV5F273DAC9VV592W9ZB5DD`
- `packages/acp-client/src/components/MessageBubble.tsx`
- `packages/acp-client/src/components/TypewriterText.tsx`
- `apps/web/src/components/project-message-view/AcpConversationItemView.tsx`
- `apps/web/src/components/MarkdownRenderer.tsx`
- `apps/web/tests/unit/components/markdown-renderer.test.tsx`
- `apps/web/tests/playwright/markdown-chat-rendering-audit.spec.ts`
- `apps/www/src/scripts/blog-mermaid.ts`
- `.claude/rules/04-ui-standards.md`
- `.claude/rules/17-ui-visual-testing.md`
- `tasks/archive/2026-03-23-fix-mermaid-xss.md`
- `tasks/archive/2026-05-28-mermaid-foreignobject-text-fix.md`
