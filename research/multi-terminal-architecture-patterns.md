# Multi-Terminal/Tabbed Terminal Architecture Patterns

## Executive Summary

This document presents research findings on implementing multi-terminal/tabbed terminal UIs, covering WebSocket multiplexing strategies, state management patterns, memory optimization techniques, UI/UX patterns from popular terminals, session routing, and Go concurrent PTY management.

## 1. WebSocket Multiplexing Strategies

### Single vs Multiple Connections

**Multiple Connections Approach:**
- **Pros:** Simple implementation, isolation between terminals, independent failure domains
- **Cons:** Higher resource usage, connection overhead, browser connection limits (6-8 per domain)
- **Use Case:** When terminal count is low (< 6) and isolation is critical

**Single Multiplexed Connection Approach:**
- **Pros:** Lower resource usage, no connection limit issues, simplified connection management
- **Cons:** Complex implementation, shared failure domain, requires protocol design
- **Use Case:** When supporting many terminals (> 6) or resource optimization is critical

### Multiplexing Implementation Patterns

Based on [WebSocket multiplexing libraries](https://github.com/sockjs/websocket-multiplex) and [IETF draft specifications](https://datatracker.ietf.org/doc/html/draft-ietf-hybi-websocket-multiplexing-01):

```javascript
// Protocol design for multiplexed WebSocket
{
  "channel": "terminal-1",  // Channel/session ID
  "type": "data|control|error",
  "payload": "..."
}
```

Key libraries:
- **[SockJS WebSocket-Multiplex](https://github.com/sockjs/websocket-multiplex)**: Thin layer for multiplexing over SockJS
- **[WebSocket Multiplexer](https://github.com/manuelstofer/websocket-multiplexer)**: Virtual channels with anonymous channel support

### Flow Control Considerations

From [WebSocket Multiplexer Overview](https://ckousik.github.io/gsoc/2017/06/16/WebSocket-Multiplexer-Overview.html):
- Round-robin scheduling for simple implementations
- Priority-based scheduling for advanced use cases
- Message fragmentation for large payloads to prevent channel blocking

## 2. State Management Patterns for React

### Library Comparison for Multiple Terminal Instances

Based on [React state management comparisons](https://medium.com/@ancilartech/large-scale-apps-101-redux-zustand-jotai-or-recoil-for-scalable-react-state-management-cebcd77e24a3) and [Jotai documentation](https://jotai.org):

**Zustand:**
- Module-first design, single store pattern
- Good for centralized terminal state
- Simple API but may require manual optimization for many terminals

**Jotai:**
- Atom-based, context-first design
- Better suited for dynamic terminal instances
- Built-in optimization for re-renders
- **Critical:** Use `atomFamily.remove(param)` for memory management with dynamic atoms

### Recommended Pattern: Jotai with AtomFamily

```typescript
// Terminal state atoms
import { atom, atomFamily } from 'jotai';

// Individual terminal state
export const terminalAtomFamily = atomFamily((terminalId: string) =>
  atom({
    id: terminalId,
    title: `Terminal ${terminalId}`,
    buffer: null,  // XTerm instance reference
    isActive: false,
    connectionState: 'disconnected' as const,
  })
);

// Active terminal tracking
export const activeTerminalIdAtom = atom<string | null>(null);

// Terminal list management
export const terminalIdsAtom = atom<string[]>([]);

// Cleanup when closing terminal
export const closeTerminal = (terminalId: string) => {
  terminalAtomFamily.remove(terminalId);
};
```

### Cross-Tab Synchronization

From [Jotai storage utilities](https://jotai.org/docs/utilities/storage):
- Built-in localStorage sync for cross-tab state
- Automatic serialization/deserialization
- Storage event subscription for real-time updates

## 3. Memory Optimization for xterm.js

### Key Memory Issues

From [xterm.js performance discussions](https://github.com/xtermjs/xterm.js/issues/791):
- A 160x24 terminal with 5000 scrollback uses ~34MB
- Multiple terminals can quickly exhaust memory
- DOM listeners can prevent garbage collection

### Optimization Strategies

**1. Dispose Inactive Terminals:**
```javascript
// Properly dispose terminal to free memory
terminal.dispose();
fitAddon.dispose();
// Remove all references
terminal = null;
```

**2. Serialize/Restore Pattern:**

Using [xterm.js serialize addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize):
```javascript
import { SerializeAddon } from '@xterm/addon-serialize';

// Save terminal state
const serializeAddon = new SerializeAddon();
terminal.loadAddon(serializeAddon);
const serialized = serializeAddon.serialize();

// Restore later
const newTerminal = new Terminal();
newTerminal.write(serialized);
```

**3. Virtual Scrolling:**
- Only render visible portion of buffer
- Lazy-load scrollback on demand

**4. Shared Web Workers:**
From [parser worker isolation](https://github.com/xtermjs/xterm.js/issues/3368):
- Move parsing to Web Worker
- Share worker between terminals
- Reduces main thread blocking

## 4. Tab UI/UX Patterns

### VS Code Terminal Architecture

From [VS Code Terminal UI documentation](https://deepwiki.com/microsoft/vscode/6.6-terminal-ui-and-layout):

**TerminalGroup Pattern:**
- Groups contain multiple split terminals
- Each group appears as single tab
- Supports horizontal/vertical splits
- Methods: `split()`, `focusNextPane()`, `resizePane()`

**UI Organization:**
```
Terminal Panel (bottom)
├── Tabs List (sidebar)
│   ├── Terminal Group 1
│   │   ├── Terminal 1.1 (split)
│   │   └── Terminal 1.2 (split)
│   └── Terminal Group 2
└── Terminal View Area
```

### Windows Terminal Patterns

**Tab Management:**
- New tab button always visible
- Tab overflow with horizontal scrolling
- Dropdown menu for tab list when many tabs
- Keyboard shortcuts (Ctrl+Tab for cycling)

### iTerm2 Patterns

**Advanced Features:**
- Tab badges for status indication
- Tab colors for visual organization
- Hotkey windows (global terminal access)
- Session restoration on restart

### Recommended UI Components

```typescript
interface TerminalTab {
  id: string;
  title: string;
  icon?: 'running' | 'stopped' | 'error';
  badge?: number;  // For unread output
  color?: string;  // Visual organization
}

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  onNewTab: () => void;
  maxVisibleTabs?: number;  // Before overflow
}
```

## 5. Session ID Routing Patterns

### Message Protocol Design

```typescript
// Client -> Server
interface ClientMessage {
  type: 'input' | 'resize' | 'ping' | 'create' | 'close';
  sessionId: string;
  payload?: any;
}

// Server -> Client
interface ServerMessage {
  type: 'output' | 'error' | 'session' | 'pong' | 'closed';
  sessionId: string;
  payload?: any;
}
```

### Router Implementation Pattern

```go
type SessionRouter struct {
    sessions map[string]*TerminalSession
    mu       sync.RWMutex
}

func (r *SessionRouter) RouteMessage(msg ClientMessage) error {
    r.mu.RLock()
    session, exists := r.sessions[msg.SessionId]
    r.mu.RUnlock()

    if !exists {
        if msg.Type == "create" {
            return r.CreateSession(msg.SessionId)
        }
        return ErrSessionNotFound
    }

    return session.HandleMessage(msg)
}
```

## 6. Go Concurrent PTY Management

### Using creack/pty Library

From [creack/pty documentation](https://github.com/creack/pty):

**Basic Session Management:**
```go
package terminal

import (
    "github.com/creack/pty"
    "os/exec"
    "sync"
)

type TerminalSession struct {
    ID      string
    PTY     *os.File
    Command *exec.Cmd
    mu      sync.Mutex
}

type TerminalManager struct {
    sessions map[string]*TerminalSession
    mu       sync.RWMutex
}

func (tm *TerminalManager) CreateSession(id string) (*TerminalSession, error) {
    cmd := exec.Command("bash")

    // Start command with PTY
    ptmx, err := pty.Start(cmd)
    if err != nil {
        return nil, err
    }

    session := &TerminalSession{
        ID:      id,
        PTY:     ptmx,
        Command: cmd,
    }

    tm.mu.Lock()
    tm.sessions[id] = session
    tm.mu.Unlock()

    // Start goroutine for this session
    go session.handleIO()

    return session, nil
}
```

### Goroutine Patterns

**Per-Session Goroutines:**
```go
func (s *TerminalSession) handleIO() {
    // Input handler
    go func() {
        for {
            // Read from WebSocket, write to PTY
            data := <-s.inputChan
            s.PTY.Write(data)
        }
    }()

    // Output handler
    go func() {
        buf := make([]byte, 4096)
        for {
            n, err := s.PTY.Read(buf)
            if err != nil {
                s.Close()
                return
            }
            // Send to WebSocket
            s.outputChan <- buf[:n]
        }
    }()

    // Resize handler
    go func() {
        for size := range s.resizeChan {
            pty.Setsize(s.PTY, &pty.Winsize{
                Rows: size.Rows,
                Cols: size.Cols,
            })
        }
    }()
}
```

### Resource Management

**Session Cleanup:**
```go
func (s *TerminalSession) Close() error {
    s.mu.Lock()
    defer s.mu.Unlock()

    // Kill process
    if s.Command.Process != nil {
        s.Command.Process.Kill()
    }

    // Close PTY
    if s.PTY != nil {
        s.PTY.Close()
    }

    // Remove from manager
    delete(tm.sessions, s.ID)

    return nil
}
```

## Implementation Recommendations

### For Simple-Agent-Manager Project

Based on the current architecture and requirements:

1. **WebSocket Strategy:** Start with multiple connections (simpler), migrate to multiplexing if hitting browser limits

2. **State Management:** Use Jotai with atomFamily for terminal instances:
   - Dynamic atom creation/removal for terminals
   - Built-in re-render optimization
   - Cross-tab synchronization support

3. **Memory Optimization:**
   - Implement serialize/restore for inactive tabs
   - Dispose xterm instances when switching tabs
   - Limit scrollback buffer size (e.g., 1000 lines)
   - Consider virtual scrolling for large outputs

4. **UI Pattern:** Follow VS Code's TerminalGroup concept:
   - Tab bar with overflow handling
   - Support for split terminals within tabs (future)
   - Keyboard navigation (Ctrl+Tab, Ctrl+Shift+T)

5. **Session Management:**
   - UUID-based session IDs
   - Message routing at both client and server
   - Graceful cleanup on disconnect

6. **Go Backend:**
   - One goroutine trio per session (input/output/resize)
   - Concurrent session map with RWMutex
   - Proper cleanup on session end

### Migration Path

**Phase 1: Multiple Terminals (Current)**
- Multiple WebSocket connections
- Simple session management
- Basic tab UI

**Phase 2: Optimization**
- Add serialize/restore for memory optimization
- Implement proper disposal patterns
- Add session persistence

**Phase 3: Advanced Features**
- WebSocket multiplexing
- Split terminals within tabs
- Cross-tab synchronization
- Session restoration on reconnect

## Performance Benchmarks to Consider

- **Terminal Creation Time:** < 100ms
- **Tab Switch Time:** < 50ms (with restoration)
- **Memory per Terminal:** < 10MB (with 1000 line scrollback)
- **Concurrent Sessions:** Support 10+ per user
- **WebSocket Latency:** < 10ms for local echo

## Security Considerations

1. **Session Isolation:** Each session must have unique ID, no cross-session data leakage
2. **Resource Limits:** Max terminals per user, max scrollback size, idle timeout
3. **Input Validation:** Sanitize all terminal input, prevent injection attacks
4. **Connection Security:** WSS only, validate tokens on each message

## Sources

- [xterm.js GitHub Repository](https://github.com/xtermjs/xterm.js)
- [Building Browser-based Terminals with xterm.js](https://www.presidio.com/technical-blog/building-a-browser-based-terminal-using-docker-and-xtermjs/)
- [VS Code Terminal UI and Layout](https://deepwiki.com/microsoft/vscode/6.6-terminal-ui-and-layout)
- [WebSocket Multiplexing Libraries](https://github.com/sockjs/websocket-multiplex)
- [WebSocket Multiplexer Overview](https://ckousik.github.io/gsoc/2017/06/16/WebSocket-Multiplexer-Overview.html)
- [creack/pty Go PTY Interface](https://github.com/creack/pty)
- [Jotai State Management](https://jotai.org)
- [React State Management Comparison](https://medium.com/@ancilartech/large-scale-apps-101-redux-zustand-jotai-or-recoil-for-scalable-react-state-management-cebcd77e24a3)
- [xterm.js Performance Discussions](https://github.com/xtermjs/xterm.js/issues/791)
- [xterm.js Serialize Addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)