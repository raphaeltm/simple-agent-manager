# Terminal scrollback replay is written before the terminal is fitted

## Problem

On reattach (page reload or reconnect), `MultiTerminal` sends `reattach_session` with the terminal's current size. A terminal restored from the server session list has never been fitted at that point, so the size is the xterm default 24x80. The VM agent then replays its raw output buffer, which was produced at the real width (for example 42 columns on a phone), into that 80-column terminal. The terminal is fitted to the real width only after that.

Readline redraws in the buffer use relative cursor moves that assume the original width. Replayed at a different width, they can overwrite a line. On staging (PR #2973, 2026-11-22) a `seq 1 300` run, replayed after a reload at 375px, showed `299` followed by the prompt, and `300` was not visible.

## Context

Found during xterm 6 staging verification (PR #2973). The mechanism does not depend on the xterm version: reattach has always used the unfitted default size. It has not been compared on xterm 5.5.

## Acceptance Criteria

- [ ] Replay is written into a terminal sized to the session's real dimensions. Options: fit before sending `reattach_session` when the container is laid out; defer writing the scrollback until after the first fit; or have the agent report its PTY size so the client can resize before writing.
- [ ] A test replays readline-style output recorded at one width and asserts no line is lost.
