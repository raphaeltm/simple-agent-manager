import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGroundingIndex } from '../../../src/durable-objects/sam-session/operator/grounding';
import {
  type LiveEvent,
  OperatorLive,
} from '../../../src/durable-objects/sam-session/operator/live';
import type { OperatorAction } from '../../../src/durable-objects/sam-session/operator/store';

const origin = 'https://app.example.test';
const project = '01M5CPTV0GKM9TXWHSX6C6E724';
const task = '01M5CPTV0GKM9TXWHSX6C6E725';
const settings = { flushMs: 50, heartbeatMs: 1_000, maxSubscribers: 2 };
const noReceipts = buildGroundingIndex([], origin);
const tasksRead: OperatorAction = {
  id: 'read',
  turn_id: 'turn',
  operation: 'sam_tasks_list',
  input_json: '{}',
  state: 'completed',
  result_json: JSON.stringify({
    tasks: [{ id: task, projectId: project, link: `${origin}/projects/${project}` }],
  }),
  created_at: 1,
};

/** Reads one SSE response into parsed events (heartbeat comments are counted separately). */
function reader(response: Response) {
  const events: LiveEvent[] = [];
  let heartbeats = 0;
  let closed = false;
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await stream.read();
      if (done) {
        closed = true;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        if (frame.startsWith(': ping')) heartbeats++;
        else if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as LiveEvent);
      }
    }
  })();
  return {
    events,
    heartbeats: () => heartbeats,
    closed: () => closed,
    text: () => {
      let text = '';
      for (const event of events) {
        if (event.type === 'snapshot') text = event.text;
        if (event.type === 'draft-reset') text = '';
        if (event.type === 'text') text = text.slice(0, event.at) + event.text;
      }
      return text;
    },
    cancel: () => stream.cancel(),
    pump,
  };
}

const text = (value: string) => ({ type: 'text-delta', payload: { id: 't', text: value } });
const reasoning = (value: string) => ({
  type: 'reasoning-delta',
  payload: { id: 'r', text: value },
});

let now = 1_000;
beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000;
});
afterEach(() => vi.useRealTimers());

function live() {
  const hub = new OperatorLive(
    () => settings,
    () => now
  );
  hub.begin('turn');
  hub.setGrounding(noReceipts);
  return hub;
}

describe('private SAM live turn view', () => {
  it('publishes the answer word by word and holds a partial word until it is complete', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.stepStarted();
    hub.chunk(text('Two tasks fin'));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe('Two tasks ');
    hub.chunk(text('ished today.'));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe('Two tasks finished ');
    // The final step is complete: its last word is released with it.
    hub.stepFinished(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toBe('Two tasks finished today.');
    expect(view.events.filter((event) => event.type === 'text').length).toBeGreaterThan(1);
  });

  it('never publishes text the receipt guard rejects, even when the step completes', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.stepStarted();
    hub.chunk(text(`Your task ${task} is done and more text follows. `));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    hub.stepFinished(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(view.events)).not.toContain(task);
    expect(view.text()).toBe('');
    // Control: the same identity is publishable once a completed receipt returned it.
    hub.stepStarted();
    hub.setGrounding(buildGroundingIndex([tasksRead], origin));
    hub.chunk(text(`Your task ${task} is done. `));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe(`Your task ${task} is done. `);
  });

  it('publishes nothing before the first receipt index arrives', async () => {
    const hub = new OperatorLive(
      () => settings,
      () => now
    );
    hub.begin('turn');
    const view = reader(hub.subscribe('turn'));
    hub.chunk(text('Hello there '));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe('');
    hub.setGrounding(noReceipts);
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe('Hello there ');
  });

  it('describes tool steps with descriptive inputs and result counts, never briefs', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.chunk({
      type: 'tool-call',
      payload: {
        toolCallId: 'call-1',
        toolName: 'sam_tasks_list',
        args: { limit: 20, query: 'deploy', message: 'PRIVATE BRIEF' },
      },
    });
    hub.chunk({
      type: 'tool-result',
      payload: {
        toolCallId: 'call-1',
        toolName: 'sam_tasks_list',
        result: { tasks: [{}, {}, {}], nextCursor: 'more' },
      },
    });
    hub.chunk({
      type: 'tool-call',
      payload: { toolCallId: 'call-2', toolName: 'sam_work_stop', args: { projectId: project } },
    });
    hub.chunk({
      type: 'tool-result',
      payload: {
        toolCallId: 'call-2',
        toolName: 'sam_work_stop',
        result: { status: 'approval_required' },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const tools = view.events.flatMap((event) => (event.type === 'tool' ? [event.activity] : []));
    expect(tools).toEqual([
      {
        id: 'call-1',
        operation: 'sam_tasks_list',
        state: 'running',
        target: { limit: 20, query: 'deploy' },
      },
      {
        id: 'call-1',
        operation: 'sam_tasks_list',
        state: 'completed',
        target: { limit: 20, query: 'deploy' },
        count: 3,
        more: true,
      },
      {
        id: 'call-2',
        operation: 'sam_work_stop',
        state: 'running',
        target: { projectId: project },
      },
      {
        id: 'call-2',
        operation: 'sam_work_stop',
        state: 'needs_approval',
        target: { projectId: project },
      },
    ]);
    expect(JSON.stringify(view.events)).not.toContain('PRIVATE BRIEF');
    expect(
      view.events.filter((event) => event.type === 'phase').map((event) => event.phase)
    ).toEqual(['working', 'thinking', 'working', 'thinking']);
  });

  it('marks failed and unconfirmed steps, and leaves the working phase when none still run', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    const call = (id: string, toolName: string) =>
      hub.chunk({ type: 'tool-call', payload: { toolCallId: id, toolName, args: {} } });
    call('thrown', 'sam_tasks_list');
    hub.chunk({
      type: 'tool-error',
      payload: { toolCallId: 'thrown', toolName: 'sam_tasks_list', error: 'Invalid input' },
    });
    call('error-result', 'sam_inbox_get');
    hub.chunk({
      type: 'tool-result',
      payload: { toolCallId: 'error-result', toolName: 'sam_inbox_get', result: {}, isError: true },
    });
    call('uncertain', 'sam_chat_start');
    hub.chunk({
      type: 'tool-result',
      payload: {
        toolCallId: 'uncertain',
        toolName: 'sam_chat_start',
        result: { status: 'uncertain', actionId: 'a' },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.snapshot('turn')?.activity.map((step) => [step.id, step.state])).toEqual([
      ['thrown', 'failed'],
      ['error-result', 'failed'],
      ['uncertain', 'uncertain'],
    ]);
    // Every settled step hands the status line back to thinking.
    expect(
      view.events.filter((event) => event.type === 'phase').map((event) => event.phase)
    ).toEqual(['working', 'thinking', 'working', 'thinking', 'working', 'thinking']);
  });

  it('drops a reader that stops reading instead of queueing frames for it forever', async () => {
    const hub = new OperatorLive(
      () => ({ ...settings, maxSubscribers: 1 }),
      () => now
    );
    hub.begin('turn');
    hub.setGrounding(noReceipts);
    const stalled = hub.subscribe('turn'); // never read
    expect(stalled.status).toBe(200);
    expect(hub.subscribe('turn').status).toBe(429);
    for (let index = 0; index < 600; index++)
      hub.chunk({
        type: 'tool-call',
        payload: { toolCallId: `c${index}`, toolName: 'sam_projects_list' },
      });
    // The stalled reader's slot is free again.
    expect(hub.subscribe('turn').status).toBe(200);
  });

  it('drops pre-tool narration, because the stored answer is the final step only', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.stepStarted();
    hub.chunk(text('Let me check your tasks. '));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(view.text()).toBe('Let me check your tasks. ');
    hub.chunk({ type: 'tool-call', payload: { toolCallId: 'c', toolName: 'sam_tasks_list' } });
    hub.stepFinished(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toBe('');
    hub.stepStarted();
    hub.chunk(text('Here is the answer.'));
    hub.stepFinished(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toBe('Here is the answer.');
  });

  it('shows the latest complete line of reasoning as plain text, and resets with the draft', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.stepStarted();
    hub.chunk(reasoning('1.  **List projects** to see what exists.\nThen open ta'));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    const previews = () =>
      view.events.flatMap((event) => (event.type === 'thinking' ? [event.text] : []));
    expect(previews()).toEqual(['List projects to see what exists.']);
    hub.chunk(reasoning(`sk ${task} to read it.\n`));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    // Reasoning is not told to label identities, so none are shown, labelled or not.
    hub.chunk(reasoning(`Hmm, ${project} could be it: ${origin}/projects/${project}\n`));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(previews()).toEqual([
      'List projects to see what exists.',
      'Then open task … to read it.',
      'Hmm, … could be it: …',
    ]);
    expect(JSON.stringify(view.events)).not.toContain(task);
    expect(JSON.stringify(view.events)).not.toContain(project);
    // A reasoning line that claims an effect without a receipt is still withheld.
    hub.chunk(reasoning('I started the task for you.\n'));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    expect(previews().at(-1)).toBe('Hmm, … could be it: …');
    hub.resetDraft();
    await vi.advanceTimersByTimeAsync(0);
    expect(previews().at(-1)).toBeNull();
    expect(hub.snapshot('turn')).toMatchObject({ phase: 'thinking', thinking: null, text: '' });
  });

  it('gives a late subscriber a snapshot, then ends every stream when the turn ends', async () => {
    const hub = live();
    hub.stepStarted();
    hub.chunk(text('Partial answer '));
    hub.chunk({ type: 'tool-call', payload: { toolCallId: 'c', toolName: 'sam_projects_list' } });
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    now = 13_500;
    const view = reader(hub.subscribe('turn'));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.events[0]).toEqual({
      type: 'snapshot',
      turnId: 'turn',
      phase: 'working',
      elapsedMs: 12_500,
      text: 'Partial answer ',
      thinking: null,
      activity: [{ id: 'c', operation: 'sam_projects_list', state: 'running' }],
    });
    hub.end('turn', 'completed');
    await view.pump;
    expect(view.events.at(-1)).toEqual({ type: 'done', state: 'completed' });
    expect(view.closed()).toBe(true);
    expect(hub.snapshot('turn')).toBeNull();
    expect(hub.subscribe('turn').status).toBe(204);
  });

  it('bounds concurrent readers, keeps idle connections alive, and forgets cancelled readers', async () => {
    const hub = live();
    const first = reader(hub.subscribe('turn'));
    const second = reader(hub.subscribe('turn'));
    const refused = hub.subscribe('turn');
    expect(refused.status).toBe(429);
    await vi.advanceTimersByTimeAsync(settings.heartbeatMs * 2);
    expect(first.heartbeats()).toBe(2);
    await first.cancel();
    // A cancelled reader frees its slot.
    expect(hub.subscribe('turn').status).toBe(200);
    expect(second.heartbeats()).toBe(2);
  });

  it('ends on exactly the answer that passed the final guard', async () => {
    const hub = live();
    const view = reader(hub.subscribe('turn'));
    hub.stepStarted();
    hub.chunk(text('The deploy finished '));
    await vi.advanceTimersByTimeAsync(settings.flushMs);
    // Only the missing tail is sent when the stream already showed a prefix.
    hub.complete('The deploy finished at 07:58 UTC.');
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toBe('The deploy finished at 07:58 UTC.');
    expect(view.events.filter((event) => event.type === 'draft-reset')).toHaveLength(0);
    // A corrected answer that diverges from the shown draft replaces it.
    hub.complete('A different, corrected answer.');
    await vi.advanceTimersByTimeAsync(0);
    expect(view.text()).toBe('A different, corrected answer.');
    expect(view.events.filter((event) => event.type === 'draft-reset')).toHaveLength(1);
  });

  it('answers 204 for a turn that is not running in this object', () => {
    const hub = live();
    expect(hub.subscribe('other-turn').status).toBe(204);
  });
});
