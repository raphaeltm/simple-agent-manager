# An Object Literal in a Render Body Can Remount an Entire Subtree

## When This Applies

Any React code that builds a **component map, render-prop map, or config object
in a render body** and hands it to a library that uses those values as component
types. The canonical case in this repo is `react-markdown`:

```tsx
// WRONG — new function identities every render
<ReactMarkdown components={{ p: ({children}) => <p className="mb-3">{children}</p> }}>
```

It applies equally to any library with the same shape: `components=` /
`renderers=` / `overrides=` props, custom cell renderers passed to a table
library, or a `formatters` map handed to a chart library.

## Why This Rule Exists

`MarkdownRenderer.tsx` had passed its overrides inline since it was written.
`react-markdown` renders each node with `createElement(components[tag], ...)`, so
a fresh object literal produced a fresh function identity for every override on
every render. React cannot diff across a changed element _type_ — it unmounts the
old subtree and mounts a new one. Every heading, paragraph and list item was
destroyed and rebuilt on every render.

Rendered output was always correct, so nothing looked wrong for months.

Then a feature depended on DOM _identity_ rather than DOM _content_. A native
text `Selection` is anchored to real nodes. On Android, long-pressing a word
selected it, the resulting `setSelection` re-render rebuilt the paragraph under
the user's finger, and the browser dropped the selection along with its drag
handles. Users could not extend a selection past one word, which made quoting a
passage impossible — on library files and, less visibly, on chat messages, which
re-render on every poll and stream update.

An earlier fix (PR #1883) addressed an adjacent symptom — the React snapshot of
the selection being nulled when the browser collapsed it — without touching the
DOM churn underneath. Fixing a symptom one layer above the cause left the real
bug in place for another PR to trip over.

## Class of Bug

**An unstable prop identity that silently converts reconciliation into
remounting.** It looks like configuration and behaves like `key` churn.

The tell: an object/array/function literal in a render body, passed to something
that treats its contents as component types or as identity-bearing config.

Nothing renders wrong, so it stays invisible until something depends on node
identity. Everything in this list breaks on remount:

- native text selection (and its touch drag-handles)
- focus, and IME composition state mid-word
- scroll position within the subtree
- `<video>`/`<audio>` playback position
- CSS transitions and animations, which restart
- uncontrolled input state
- anything holding a `ref` to a node inside the subtree

## Hard Requirements

1. **Hoist to module scope when the config closes over nothing.** A single shared
   instance is correct and cheapest. Add a comment saying it is hoisted on
   purpose, or someone will "tidy" it back inline.

2. **`useMemo` when it must close over props or state**, with those values as
   deps. Never rebuild per render.

3. **Memoizing the wrapper is not a substitute.** `memo` prevents re-renders it
   can short-circuit; it does not make the identity stable when a real re-render
   does happen (content changed, or a caller passes an inline `style` literal so
   the memo always misses). Fix the identity; add `memo` as reinforcement.

4. **Treat DOM identity as a contract wherever a user gesture spans renders.**
   Selection, drag, focus and scroll all take longer than one render. If a
   feature depends on nodes surviving, that is a requirement, not an
   implementation detail.

## Required Tests

- **A DOM-identity assertion**: capture a node, trigger an unrelated parent
  re-render, and assert `expect(after).toBe(before)` — identity, not equality. A
  remount produces nodes that serialize identically, so `toEqual` passes while
  the bug is present. This is the whole point of the test.
- **A behavioural assertion for the thing identity protects**: e.g. create a
  `Selection` over the subtree, re-render, and assert it is still non-collapsed
  with the same text. jsdom models enough of the Selection API for this.
- **A control proving the memo did not make the component stale**: change the
  content prop and assert the output updates. Without it, "nothing re-rendered"
  passes for the wrong reason.
- **Prove all of the above discriminating** by reverting the fix and confirming
  exactly the identity and behavioural assertions go red while the control stays
  green.

## A Test Can Use The Real Trigger And Still Miss This

The Playwright audit for the affected feature _did_ drive a real selection — and
passed while the feature was unusable. It set the selection with
`document.createRange()` and read it back in the same tick, so it never sat
through a re-render mid-gesture the way a thumb does.

`.claude/rules/62` requires reaching the feature the way production does. Extend
that to **duration**: when a gesture spans multiple renders in reality, a test
that completes it within one render has not reproduced it. Ask whether anything
can re-render between the start and end of the interaction, and if so, make the
test re-render there.

## Quick Compliance Check

- [ ] No object/array/function literal in a render body is passed as a component
      map or identity-bearing config
- [ ] Hoisted to module scope, or `useMemo`d with correct deps
- [ ] A comment records that the hoist is deliberate
- [ ] DOM-identity assertion uses `toBe`, not `toEqual`
- [ ] A behavioural assertion covers what identity protects
- [ ] A control proves memoization did not introduce staleness
- [ ] All of it verified discriminating against the pre-fix code

## References

- Fix: `apps/web/src/components/MarkdownRenderer.tsx` (`MARKDOWN_COMPONENTS`)
- Test: `apps/web/tests/unit/components/markdown-dom-stability.test.tsx`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — the duration corollary above
- `.claude/rules/48-stale-while-revalidate-ui.md` — the context-value analogue: an
  unmemoized provider value causing refetch loops is the same identity bug one
  layer up
- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis
