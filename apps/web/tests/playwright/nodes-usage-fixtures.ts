/**
 * Mock data and API routes for the /nodes page, shared by `nodes-usage-audit.spec.ts` (stress
 * cases) and `docs-screenshots-nodes.spec.ts` (the documentation image).
 */
import type { Page, Route } from '@playwright/test';

export const NOW = Date.now();
export const MINUTE = 60_000;
export const GB = 1024 * 1024 * 1024;

export const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'raph@example.com',
    name: 'Raphaël',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(NOW + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

export function makeNode(overrides: Record<string, unknown>) {
  return {
    id: 'node-1',
    name: 'Auto: Review previous session context using SA',
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'large',
    vmLocation: 'fsn1',
    nodeRole: 'workspace',
    nodeClass: 'managed',
    providerInstanceType: 'cx53',
    providerInstanceVcpuCount: 16,
    providerInstanceMemoryMb: 32768,
    providerInstanceDiskGb: 320,
    providerInstancePriceDisplay: '€22.99/month',
    ipAddress: '1.2.3.4',
    lastHeartbeatAt: new Date(NOW - 20_000).toISOString(),
    heartbeatStaleAfterSeconds: 180,
    lastMetrics: { cpuLoadAvg1: 2.1, memoryPercent: 34, diskPercent: 12 },
    errorMessage: null,
    createdAt: new Date(NOW - 3 * 3600_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

/** History ends ~12 minutes ago, as a 15-minute upload cadence leaves it. */
export function series(seed: number, cpuMillis: number, memoryGb: number, minutes = 48) {
  const end = NOW - 12 * MINUTE;
  const start = Array.from({ length: minutes }, (_, i) => end - (minutes - i) * MINUTE);
  let x = seed;
  const wobble = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280 - 0.5;
  };
  return {
    start,
    cpuMillis: start.map(() => Math.max(0, Math.round(cpuMillis * (1 + wobble())))),
    memoryBytes: start.map(() => Math.round(memoryGb * GB * (1 + wobble() * 0.15))),
  };
}

export function makeSession(
  overrides: Record<string, unknown> & { cpu?: number; mem?: number; seed?: number }
) {
  const { cpu = 600, mem = 2, seed = 7, ...rest } = overrides;
  const status = (rest.status as string | undefined) ?? 'running';
  return {
    holdsReservation: ['running', 'creating', 'recovery'].includes(status),
    historyTruncated: false,
    workspaceId: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-sam',
    projectName: 'SAM',
    chatSessionId: 'chat-1',
    title: 'Nodes page: ship the live CPU and memory view',
    ownerUserId: 'user-1',
    ownerName: 'Raphaël',
    isMine: true,
    status: 'running',
    createdAt: new Date(NOW - 70 * MINUTE).toISOString(),
    reservation: { cpuMillis: 2000, memoryMb: 4096, diskMb: 10240, exclusiveNode: false },
    series: series(seed, cpu, mem),
    historyEndsAt: NOW - 12 * MINUTE,
    historyOmitted: false,
    ...rest,
  };
}

export function usage(workspaces: unknown[]) {
  return {
    windowMinutes: 60,
    windowStart: NOW - 60 * MINUTE,
    windowEnd: NOW,
    bucketMs: MINUTE,
    historyOmittedCount: 0,
    historyTruncatedCount: 0,
    workspacesOmitted: false,
    workspaces,
  };
}

export async function setupApiMocks(
  page: Page,
  options: {
    nodes?: unknown[];
    sessions?: unknown[];
    usageError?: boolean;
    nodesError?: boolean;
    /** The signed-in user; defaults to `MOCK_USER`. */
    user?: unknown;
  }
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.startsWith('/api/auth/')) return route.fulfill({ json: options.user ?? MOCK_USER });
    if (path.startsWith('/api/notifications'))
      return route.fulfill({ json: { notifications: [], total: 0 } });
    if (path === '/api/projects') return route.fulfill({ json: { projects: [], total: 0 } });
    if (path === '/api/credentials' || path === '/api/github/installations')
      return route.fulfill({ json: [] });
    if (path === '/api/credentials/agent') return route.fulfill({ json: { credentials: [] } });
    if (path === '/api/providers/catalog') return route.fulfill({ json: { catalogs: [] } });
    if (path === '/api/capacity-pools/defaults')
      return route.fulfill({
        json: {
          effectiveSummary: {
            scope: 'installation',
            state: 'configured-ready',
            strategy: 'pack',
            exhaustionPolicy: 'fail',
            availableCandidateCount: 1,
            nativeOfferings: [
              {
                provider: 'hetzner',
                location: 'nbg1',
                providerInstanceType: 'cx43',
                displayName: 'CX43',
                vcpu: 8,
                memoryMb: 16384,
                diskGb: 160,
                price: '€16/month',
              },
            ],
          },
        },
      });
    if (path === '/api/nodes/resource-usage') {
      if (options.usageError)
        return route.fulfill({
          status: 500,
          json: { error: 'INTERNAL_ERROR', message: 'Usage store unavailable' },
        });
      return route.fulfill({ json: usage(options.sessions ?? []) });
    }
    if (path === '/api/nodes') {
      if (options.nodesError)
        return route.fulfill({
          status: 500,
          json: { error: 'INTERNAL_ERROR', message: 'Nodes store unavailable' },
        });
      return route.fulfill({ json: options.nodes ?? [] });
    }
    return route.fulfill({ json: {} });
  });
}
