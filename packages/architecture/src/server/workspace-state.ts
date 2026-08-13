import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { compareCanonicalStrings } from '../canonical-order';
import {
  DEFAULT_SERVER_STABLE_LOAD_ATTEMPTS,
  DEFAULT_SERVER_WATCH_INTERVAL_MS,
  DEFAULT_WORKSPACE_DIR,
} from '../constants';
import { hasErrors } from '../diagnostics';
import { loadArchitectureWorkspace } from '../loader';
import type { LoadedWorkspace, LoadWorkspaceOptions } from '../types';
import type { EventHub } from './events';

export interface WorkspaceStateOptions extends LoadWorkspaceOptions {
  watchIntervalMs?: number;
}

export type WorkspaceMutationResult<T> =
  | { status: 'applied'; value: T }
  | { status: 'invalid' }
  | { status: 'persisted-invalid'; value: T };

export class WorkspaceState {
  private loaded?: LoadedWorkspace;
  private invalid?: LoadedWorkspace;
  private fingerprint = '';
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: WorkspaceStateOptions,
    private readonly events: EventHub
  ) {}

  async start(): Promise<void> {
    await this.reload('initial');
    this.stopped = false;
    this.scheduleWatch();
  }

  current(): LoadedWorkspace {
    const loaded = this.loaded ?? this.invalid;
    if (!loaded) throw new Error('Architecture workspace has not loaded yet.');
    return loaded;
  }

  lastInvalid(): LoadedWorkspace | undefined {
    return this.invalid;
  }

  hasValidModel(): boolean {
    return this.loaded !== undefined;
  }

  isLatestValid(): boolean {
    return this.loaded !== undefined && this.invalid === undefined;
  }

  diagnostics(): LoadedWorkspace['diagnostics'] {
    return this.invalid?.diagnostics ?? this.current().diagnostics;
  }

  reload(reason: string): Promise<boolean> {
    return this.runExclusive(() => this.performReload(reason));
  }

  mutateLatest<T>(
    reason: string,
    mutation: (loaded: LoadedWorkspace) => Promise<T>
  ): Promise<WorkspaceMutationResult<T>> {
    return this.runExclusive(async () => {
      if (!(await this.performReload(`pre-${reason}`))) return { status: 'invalid' };
      const value = await mutation(this.current());
      return (await this.performReload(reason))
        ? { status: 'applied', value }
        : { status: 'persisted-invalid', value };
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.operationTail.catch(() => undefined);
  }

  private async performReload(reason: string): Promise<boolean> {
    const { next, fingerprint } = await this.loadStableSnapshot();
    const changed = fingerprint !== this.fingerprint;
    if (hasErrors(next.diagnostics)) {
      this.invalid = next;
      this.fingerprint = fingerprint;
      if (changed) {
        this.events.publish('architecture:invalid', { reason, diagnostics: next.diagnostics });
      }
      return false;
    }
    const previousThreads = threadFingerprint(this.loaded?.workspace.threads ?? []);
    this.loaded = next;
    this.invalid = undefined;
    this.fingerprint = fingerprint;
    if (changed) {
      this.events.publish('architecture:model', { reason, summary: next.workspace.manifest.name });
      if (previousThreads !== threadFingerprint(next.workspace.threads)) {
        this.events.publish('architecture:threads', {
          reason,
          count: next.workspace.threads.length,
        });
      }
    }
    return true;
  }

  private async loadStableSnapshot(): Promise<{
    next: LoadedWorkspace;
    fingerprint: string;
  }> {
    const root = path.resolve(this.options.workspaceRoot ?? DEFAULT_WORKSPACE_DIR);
    for (let attempt = 0; attempt < DEFAULT_SERVER_STABLE_LOAD_ATTEMPTS; attempt += 1) {
      const before = await fingerprintDirectory(root);
      const next = await loadArchitectureWorkspace(this.options);
      const after = await fingerprintDirectory(next.workspace.workspaceRoot);
      if (before === after) return { next, fingerprint: after };
    }
    throw new Error('Architecture workspace changed continuously while loading.');
  }

  private async checkForChanges(): Promise<void> {
    const nextFingerprint = await fingerprintDirectory(this.current().workspace.workspaceRoot);
    if (nextFingerprint === this.fingerprint) return;
    await this.reload('file-change');
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private scheduleWatch(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.checkForChanges()
        .catch((error: unknown) => {
          this.events.publish('architecture:invalid', {
            reason: 'watch-error',
            diagnostics: [
              {
                severity: 'error',
                code: 'watch-error',
                message: error instanceof Error ? error.message : String(error),
              },
            ],
          });
        })
        .finally(() => this.scheduleWatch());
    }, this.options.watchIntervalMs ?? DEFAULT_SERVER_WATCH_INTERVAL_MS);
  }
}

function threadFingerprint(threads: LoadedWorkspace['workspace']['threads']): string {
  return threads
    .map((thread) => `${thread.id}:${thread.status}:${thread.updatedAt}:${thread.messages.length}`)
    .join('|');
}

async function fingerprintDirectory(root: string): Promise<string> {
  const entries = await collectEntries(root);
  return entries.join('|');
}

async function collectEntries(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      values.push(...(await collectEntries(absolute)));
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = await stat(absolute);
    values.push(`${absolute}:${stats.mtimeMs}:${stats.size}`);
  }
  return values.sort(compareCanonicalStrings);
}
