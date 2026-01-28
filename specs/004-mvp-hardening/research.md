# Technical Research: MVP Hardening

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Phase**: 0 - Technical Research
**Date**: 2026-01-27

## Purpose

This document consolidates technical research for implementing the MVP hardening features. It resolves technical questions and documents technology choices with rationale.

---

## 1. Provisioning Timeout Implementation

### Decision: Cloudflare Cron Triggers

**Rationale**:
- Cron triggers are simpler and already supported with Hono framework
- Sufficient for checking workspace timeouts at regular intervals
- No additional infrastructure cost (included with Workers)
- Durable Objects would be over-engineering for this use case

**Implementation Pattern**:
```typescript
// wrangler.toml
[triggers]
crons = ["*/5 * * * *"]  // Every 5 minutes

// src/index.ts
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await checkProvisioningTimeouts(env);
  }
};

async function checkProvisioningTimeouts(env: Env) {
  const db = drizzle(env.DATABASE);
  const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

  const stuckWorkspaces = await db
    .select()
    .from(workspaces)
    .where(and(
      eq(workspaces.status, 'creating'),
      lt(workspaces.createdAt, cutoff)
    ));

  for (const ws of stuckWorkspaces) {
    await db.update(workspaces)
      .set({ status: 'error', errorReason: 'Provisioning timed out after 10 minutes' })
      .where(eq(workspaces.id, ws.id));
  }
}
```

**Alternatives Considered**:

| Alternative | Why Rejected |
|-------------|--------------|
| Durable Objects with alarms | Over-engineering; adds complexity without benefit |
| Client-side polling | Unreliable if user closes browser |
| Queue-based with delayed messages | More complex, requires Queues setup |

---

## 2. Bootstrap Token Storage & Mechanism

### Decision: Cloudflare KV with TTL

**Rationale**:
- KV supports automatic TTL expiration (5 minutes)
- Simple get/delete operations for single-use semantics
- No cleanup jobs needed (auto-expires)
- Already using KV for sessions

**Implementation Pattern**:
```typescript
// Token generation (during workspace creation)
const bootstrapToken = crypto.randomUUID();
const credentials = {
  workspaceId,
  hetznerToken: encryptedHetznerToken,
  callbackToken: jwt,
  githubToken: encryptedGithubToken
};

await env.KV.put(
  `bootstrap:${bootstrapToken}`,
  JSON.stringify(credentials),
  { expirationTtl: 300 } // 5 minutes
);

// Cloud-init only receives the bootstrap token, not secrets
const cloudInit = generateCloudInit({
  bootstrapToken,
  controlPlaneUrl: env.API_URL
});

// Token redemption endpoint (called by VM)
app.post('/api/bootstrap/:token', async (c) => {
  const token = c.req.param('token');
  const data = await c.env.KV.get(`bootstrap:${token}`, 'json');

  if (!data) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  // Delete immediately to ensure single-use
  await c.env.KV.delete(`bootstrap:${token}`);

  return c.json({
    hetznerToken: decrypt(data.hetznerToken),
    callbackToken: data.callbackToken,
    githubToken: decrypt(data.githubToken)
  });
});
```

**Alternatives Considered**:

| Alternative | Why Rejected |
|-------------|--------------|
| D1 database table | Requires cleanup job for expired tokens |
| In-memory (Durable Objects) | Overkill for simple key-value with TTL |
| JWT with embedded credentials | Exposes encrypted secrets in cloud-init |

---

## 3. WebSocket Reconnection for Terminal

### Decision: Custom Reconnection Wrapper

**Rationale**:
- xterm.js AttachAddon doesn't include reconnection logic
- Need custom handling for exponential backoff and UI state
- Can be extracted to shared package for reuse

**Implementation Pattern**:
```typescript
// packages/terminal/src/useWebSocket.ts
interface ReconnectingWebSocketOptions {
  url: string;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  onStateChange?: (state: ConnectionState) => void;
}

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export function useReconnectingWebSocket(options: ReconnectingWebSocketOptions) {
  const {
    url,
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    onStateChange
  } = options;

  const [state, setState] = useState<ConnectionState>('connecting');
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimeoutRef = useRef<number>();

  const connect = useCallback(() => {
    const ws = new WebSocket(url);

    ws.onopen = () => {
      retriesRef.current = 0;
      setState('connected');
    };

    ws.onclose = (event) => {
      // Code 1000 = normal closure, don't reconnect
      if (event.code === 1000) return;

      if (retriesRef.current < maxRetries) {
        setState('reconnecting');
        const delay = Math.min(baseDelay * Math.pow(2, retriesRef.current), maxDelay);
        retriesRef.current++;
        reconnectTimeoutRef.current = setTimeout(connect, delay);
      } else {
        setState('failed');
      }
    };

    setSocket(ws);
  }, [url, maxRetries, baseDelay, maxDelay]);

  const retry = useCallback(() => {
    retriesRef.current = 0;
    setState('connecting');
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      socket?.close(1000);
    };
  }, []);

  useEffect(() => {
    onStateChange?.(state);
  }, [state, onStateChange]);

  return { socket, state, retry };
}
```

**Alternatives Considered**:

| Alternative | Why Rejected |
|-------------|--------------|
| reconnecting-websocket library | Adds dependency; simple to implement ourselves |
| Service Worker proxy | Over-engineering; doesn't help with terminal state |
| Polling fallback | Poor UX for terminal; WebSocket is required |

---

## 4. Shared Terminal Package Structure

### Decision: New `packages/terminal` Package

**Rationale**:
- Follows monorepo structure (packages/ for shared libraries)
- Enables consistent terminal behavior in web UI and VM agent UI
- Single place to implement reconnection, status bar, deadline display

**Package Structure**:
```
packages/terminal/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public exports
│   ├── Terminal.tsx          # Main terminal component
│   ├── StatusBar.tsx         # Connection state + shutdown deadline
│   ├── ConnectionOverlay.tsx # Reconnecting/failed overlay
│   ├── useWebSocket.ts       # Reconnection hook
│   ├── useIdleDeadline.ts    # Deadline tracking hook
│   └── types.ts              # Shared types
└── tests/
    └── useWebSocket.test.ts
```

**Component API**:
```typescript
// packages/terminal/src/Terminal.tsx
interface TerminalProps {
  wsUrl: string;
  shutdownDeadline?: Date;
  onActivity?: () => void;
  className?: string;
}

export function Terminal({ wsUrl, shutdownDeadline, onActivity, className }: TerminalProps) {
  const { socket, state, retry } = useReconnectingWebSocket({ url: wsUrl });
  // ... xterm.js integration
}
```

**Consumers**:
- `apps/web/src/pages/Workspace.tsx` - Control plane workspace view
- `packages/vm-agent/ui/src/App.tsx` - VM agent terminal UI

---

## 5. Idle Deadline Model Changes

### Decision: Absolute Timestamp Tracking

**Rationale**:
- Clearer UX: "Shutting down at 3:45 PM" vs "Idle for 25 minutes"
- Simpler logic: compare `now > deadline` vs track last activity
- Works across timezone boundaries (UTC internally, local display)

**Implementation Pattern**:

**VM Agent (Go)**:
```go
// internal/idle/detector.go
type Detector struct {
    deadline      time.Time
    idleTimeout   time.Duration
    mu            sync.RWMutex
}

func (d *Detector) RecordActivity() {
    d.mu.Lock()
    defer d.mu.Unlock()
    d.deadline = time.Now().Add(d.idleTimeout)
}

func (d *Detector) GetDeadline() time.Time {
    d.mu.RLock()
    defer d.mu.RUnlock()
    return d.deadline
}

func (d *Detector) IsExpired() bool {
    return time.Now().After(d.GetDeadline())
}
```

**Heartbeat API Response**:
```typescript
// POST /api/workspaces/:id/heartbeat response
interface HeartbeatResponse {
  action: 'continue' | 'shutdown';
  shutdownDeadline: string; // ISO 8601 timestamp
}
```

**Frontend Display**:
```typescript
// packages/terminal/src/StatusBar.tsx
function formatDeadline(deadline: Date): string {
  const now = new Date();
  const diff = deadline.getTime() - now.getTime();
  const minutes = Math.floor(diff / 60000);

  if (minutes <= 5) {
    return `Shutting down in ${minutes} min at ${formatTime(deadline)}`;
  }
  return `Auto-shutdown at ${formatTime(deadline)}`;
}
```

---

## 6. Ownership Validation Pattern

### Decision: Middleware + Helper Function

**Rationale**:
- Centralized validation logic (DRY)
- Applied consistently via middleware
- Returns 404 (not 403) to prevent information disclosure

**Implementation Pattern**:
```typescript
// apps/api/src/middleware/workspace-auth.ts
export async function requireWorkspaceOwnership(
  c: Context,
  workspaceId: string
): Promise<Workspace | null> {
  const user = c.get('user');
  const db = drizzle(c.env.DATABASE);

  const workspace = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (!workspace[0] || workspace[0].userId !== user.id) {
    return null; // Caller should return 404
  }

  return workspace[0];
}

// Usage in route
app.get('/api/workspaces/:id', authMiddleware, async (c) => {
  const workspace = await requireWorkspaceOwnership(c, c.req.param('id'));
  if (!workspace) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  return c.json(workspace);
});
```

---

## Resolved Questions

| Question | Resolution |
|----------|------------|
| Provisioning timeout mechanism? | Cloudflare Cron Triggers (every 5 minutes) |
| Bootstrap token storage? | Cloudflare KV with 5-minute TTL |
| WebSocket reconnection? | Custom hook with exponential backoff |
| Shared terminal package? | New `packages/terminal` in monorepo |
| Idle tracking model? | Absolute deadline timestamp |
| Ownership validation? | Middleware pattern returning 404 |

---

## References

### Cloudflare Documentation
- [Cron Triggers](https://developers.cloudflare.com/workers/examples/cron-trigger)
- [KV TTL](https://developers.cloudflare.com/kv/api/write-key-value-pairs/#expiring-keys)
- [Hono with Cron](https://developers.cloudflare.com/workers/examples/cron-trigger)

### xterm.js Documentation
- [AttachAddon](https://xtermjs.org/docs/api/addons/attach/)
- [FitAddon](https://xtermjs.org/docs/api/addons/fit/)
- [Event Handling](https://xtermjs.org/docs/api/terminal/classes/terminal/#events)

### Project Documentation
- [Constitution](../../.specify/memory/constitution.md)
- [Existing VM Agent](../../packages/vm-agent/)
- [Existing Shared Types](../../packages/shared/)
