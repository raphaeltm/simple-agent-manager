import { createHash } from 'node:crypto';

import type { APIRequestContext } from '@playwright/test';

import type { Json } from './staging-sam-dispatch-evidence';
import { observationReserveMs } from './staging-sam-dispatch-provisioning';

type Check = (condition: boolean, label: string) => void;
const READ_PATHS: Array<[RegExp, string]> = [
  [/^\/api\/sam\/settings$/, '/api/sam/settings'],
  [/^\/api\/auth\/get-session$/, '/api/auth/get-session'],
  [/^\/api\/sam\/turns$/, '/api/sam/turns'],
  [/^\/api\/projects\/[^/]+$/, '/api/projects/:project'],
  [/^\/api\/projects\/[^/]+\/tasks\/[^/]+$/, '/api/projects/:project/tasks/:task'],
  [/^\/api\/projects\/[^/]+\/acp-sessions$/, '/api/projects/:project/acp-sessions'],
  [/^\/api\/projects\/[^/]+\/sessions\/[^/]+$/, '/api/projects/:project/sessions/:session'],
  [/^\/api\/projects\/[^/]+\/agent-profiles(?:\/[^/]+)?$/, '/api/projects/:project/agent-profiles'],
  [/^\/api\/workspaces(?:\/[^/]+)?$/, '/api/workspaces'],
  [/^\/api\/nodes(?:\/[^/]+)?$/, '/api/nodes'],
  [/^\/api\/nodes\/[^/]+\/events$/, '/api/nodes/:node/events'],
];

export function dispatchReader(
  request: APIRequestContext,
  ledger: Json,
  check: Check,
  timeout: number
) {
  return async (url: string): Promise<Json> => {
    const pathname = new URL(url).pathname;
    const read = {
      path: READ_PATHS.find(([pattern]) => pattern.test(pathname))?.[1] ?? 'other',
      status: null as number | null,
      category: 'pending',
    };
    ledger.lastRead = read;
    const response = await request.get(url, { timeout }).catch((error: unknown) => {
      read.category =
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'transport-error';
      check(false, 'Scoped read transport completed');
      throw new Error('Scoped read transport failed');
    });
    read.status = response.status();
    read.category = response.status() === 200 ? 'parsing' : 'http-status';
    check(response.status() === 200, 'Scoped read HTTP status is 200');
    const result: Json = await response.json().catch(() => {
      read.category = 'invalid-json';
      check(false, 'Scoped read response is valid JSON');
      throw new Error('Scoped read JSON parsing failed');
    });
    read.category = 'success';
    return result;
  };
}
interface ObservationInput {
  ledger: Json;
  deadline: number;
  startedAt: number;
  profileName: string;
  projectId: string;
  projectApi: string;
  repository: string;
  stagingApi: string;
  baselineWorkspaces: Set<string>;
  reportFixture: string;
  privateCanary: string;
  stopOnly: boolean;
  check: Check;
  save: () => Promise<void>;
  get: (url: string) => Promise<Json>;
  wait: (ms: number) => Promise<void>;
  observeProvisioning: () => Promise<void>;
}

export async function verifyAwakeBeforeStop(
  input: Pick<
    ObservationInput,
    'ledger' | 'get' | 'check' | 'projectApi' | 'stagingApi' | 'startedAt'
  >
) {
  const { ledger, get, check } = input;
  const workspace = await get(`${input.stagingApi}/api/workspaces/${ledger.workspaceId}`);
  const node = await get(`${input.stagingApi}/api/nodes/${ledger.nodeId}`);
  const acp = await get(
    `${input.projectApi}/acp-sessions?chatSessionId=${ledger.sessionId}&limit=10`
  );
  check(
    Number.isFinite(node.heartbeatStaleAfterSeconds) && node.heartbeatStaleAfterSeconds > 0,
    'Node heartbeat freshness policy is present and positive'
  );
  check(
    Number.isFinite(Date.parse(node.lastHeartbeatAt)),
    'Node heartbeat timestamp is present and parseable'
  );
  const freshAfter = Math.max(input.startedAt, Date.now() - node.heartbeatStaleAfterSeconds * 1000);
  check(
    workspace.nodeId === ledger.nodeId &&
      workspace.status === 'running' &&
      node.status === 'running' &&
      Date.parse(node.lastHeartbeatAt) >= freshAfter &&
      acp.sessions.some(
        (item: Json) =>
          item.chatSessionId === ledger.sessionId &&
          item.workspaceId === ledger.workspaceId &&
          item.nodeId === ledger.nodeId &&
          item.agentType === 'openai-codex' &&
          item.status === 'running' &&
          Number(item.lastHeartbeatAt) >= freshAfter
      ),
    'Exact owned runtime is awake with fresh heartbeats immediately before confirmation'
  );
}

export async function observeDispatchSession(
  input: ObservationInput,
  afterIds = new Set<string>()
): Promise<void> {
  const {
    ledger,
    deadline,
    startedAt,
    profileName: name,
    projectId: PROJECT,
    projectApi: PROJECT_API,
    repository: REPOSITORY,
    stagingApi: STAGING_API,
    baselineWorkspaces,
    reportFixture,
    privateCanary,
    check,
    save,
    get,
  } = input;
  const decode = (value: string | null): Json => (value ? JSON.parse(value) : {});
  const responseDeadline = deadline - observationReserveMs(input.stopOnly, afterIds.size > 0);
  let nextProvisioningObservation = 0;
  while (Date.now() < responseDeadline) {
    if (input.stopOnly && !ledger.workspaceId && Date.now() >= nextProvisioningObservation) {
      await input.observeProvisioning();
      nextProvisioningObservation = Date.now() + 30_000;
    }
    let observedHardwareReady = false;
    let runtimeAwake = false;
    const task = await get(`${PROJECT_API}/tasks/${ledger.taskId}`);
    check(
      task.projectId === PROJECT && task.taskMode === 'conversation',
      'Task is scoped conversation'
    );
    check(
      [ledger.profileId, name].includes(task.agentProfileHint),
      'Task resolves temporary profile'
    );
    check(task.outputPrUrl === null, 'No task pull request');
    if (task.workspaceId) {
      check(
        !ledger.workspaceId || ledger.workspaceId === task.workspaceId,
        'Follow-up never allocates another workspace'
      );
      ledger.workspaceId = task.workspaceId;
      await save(); // Record identity before subsequent assertions or cleanup.
      check(!baselineWorkspaces.has(task.workspaceId), 'Workspace was created by this run');
      const workspace = await get(`${STAGING_API}/api/workspaces/${task.workspaceId}`);
      ledger.nodeId = workspace.nodeId;
      await save();
      const reservation = decode(workspace.resolvedReservationJson);
      ledger.workloadReservation = {
        cpuMillis: reservation.cpuMillis,
        memoryMb: reservation.memoryMb,
      };
      await save();
      check(
        Number.isSafeInteger(reservation.cpuMillis) &&
          reservation.cpuMillis > 0 &&
          reservation.cpuMillis <= 2000 &&
          Number.isSafeInteger(reservation.memoryMb) &&
          reservation.memoryMb > 0 &&
          reservation.memoryMb <= 3584,
        'Resolved workload request respects 2 vCPU and 3.5 GB policy cap'
      );
      const node = await get(`${STAGING_API}/api/nodes/${workspace.nodeId}`);
      runtimeAwake = workspace.status === 'running' && node.status === 'running';
      const cpu = node.observedProviderInstanceVcpuCount;
      const memory = node.observedProviderInstanceMemoryMb;
      ledger.observedHardware = {
        nodeId: node.id,
        provider: node.provider,
        vcpuCount: cpu ?? null,
        memoryMb: memory ?? null,
        source: node.observedHardwareSource ?? null,
        lastHeartbeatAt: node.lastHeartbeatAt,
      };
      await save(); // Record the host selected by the user's configured pool.
      check(
        (cpu == null || (Number.isFinite(cpu) && cpu > 0)) &&
          (memory == null || (Number.isFinite(memory) && memory > 0)),
        'Observed host has valid hardware metadata without an invented size ceiling'
      );
      // Bootstrap can precede observed metadata. Missing values must wait, never pass.
      observedHardwareReady =
        cpu != null && memory != null && Date.parse(node.lastHeartbeatAt) >= startedAt;
      check(
        workspace.projectId === PROJECT && workspace.repository === REPOSITORY,
        'Workspace matches exact project repository'
      );
      check(workspace.workspaceProfile === 'lightweight', 'Lightweight workspace');
    }
    const acp = await get(`${PROJECT_API}/acp-sessions?chatSessionId=${ledger.sessionId}&limit=10`);
    const linked = acp.sessions.filter((item: Json) => item.chatSessionId === ledger.sessionId);
    ledger.acp = linked.map((item: Json) => ({
      id: item.id,
      workspaceId: item.workspaceId,
      nodeId: item.nodeId,
      agentType: item.agentType,
      status: item.status,
      lastHeartbeatAt: item.lastHeartbeatAt,
    }));
    check(
      linked.every((item: Json) => item.agentType === 'openai-codex'),
      'Observed ACP agent is Codex'
    );
    const detail = await get(`${PROJECT_API}/sessions/${ledger.sessionId}?limit=100`);
    check(detail.session.task?.id === ledger.taskId, 'Chat remains attached to same task');
    const messages: Json[] = detail.messages;
    const assistantRuns: string[] = [];
    let previousRole = '';
    for (const item of messages) {
      if (item.role === 'assistant') {
        if (previousRole !== 'assistant') assistantRuns.push('');
        assistantRuns[assistantRuns.length - 1] += String(item.content ?? '');
      }
      previousRole = item.role;
    }
    const answer = messages.find(
      (item) =>
        item.role === 'assistant' &&
        !afterIds.has(item.id) &&
        String(item.content ?? '').trim().length > 0
    );
    const freshAgent = linked.some(
      (item: Json) =>
        Number(item.lastHeartbeatAt) >= startedAt &&
        item.workspaceId === ledger.workspaceId &&
        (!input.stopOnly || item.status === 'running')
    );
    ledger.lastObservation = {
      elapsedMs: Date.now() - startedAt,
      responseDeadlineMs: responseDeadline - startedAt,
      messageCount: messages.length,
      hasMore: detail.hasMore === true,
      answerPresent: Boolean(answer),
      activityIdle: detail.state?.activity === 'idle',
      hardwareReady: observedHardwareReady,
      freshAgent,
      runtimeAwake,
    };
    if (input.stopOnly && runtimeAwake && observedHardwareReady && freshAgent) {
      ledger.checks.liveAgentHeartbeat = true;
      ledger.checks.observedHardwareVerified = true;
      ledger.checks.awakeRuntimeReadyForControlledStop = true;
      await save();
      return;
    }
    if (
      !input.stopOnly &&
      answer &&
      observedHardwareReady &&
      detail.state?.activity === 'idle' &&
      freshAgent
    ) {
      if (afterIds.size === 0) {
        check(
          assistantRuns.some((content) => content.includes(reportFixture)),
          'Actual project assistant report contains inert injection fixture'
        );
      }
      check(
        !messages.some((item) => String(item.content ?? '').includes(privateCanary)) &&
          !assistantRuns.some((content) => content.includes(privateCanary)),
        'Project transcript contains no private planning marker'
      );
      ledger.answer = {
        id: answer.id,
        characters: String(answer.content).length,
        sha256: createHash('sha256').update(String(answer.content)).digest('hex'),
      };
      ledger.messageIds = messages.map((item) => item.id);
      ledger.checks.liveAgentHeartbeat = true;
      ledger.checks.observedHardwareVerified = true;
      await save();
      return;
    }
    await save();
    check(!['failed', 'cancelled'].includes(task.status), 'Project task has not failed');
    await input.wait(5_000);
  }
  check(false, 'Bounded project observation deadline reached before readiness');
}
