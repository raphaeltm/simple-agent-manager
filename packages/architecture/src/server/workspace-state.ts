import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SERVER_WATCH_INTERVAL_MS } from '../constants';
import { hasErrors } from '../diagnostics';
import { loadArchitectureWorkspace } from '../loader';
import type { LoadedWorkspace, LoadWorkspaceOptions } from '../types';
import type { EventHub } from './events';

export interface WorkspaceStateOptions extends LoadWorkspaceOptions {
  watchIntervalMs?: number;
}

export class WorkspaceState {
  private loaded?: LoadedWorkspace;
  private invalid?: LoadedWorkspace;
  private fingerprint = '';
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: WorkspaceStateOptions,
    private readonly events: EventHub
  ) {}

  async start(): Promise<void> {
    await this.reload('initial');
    this.timer = setInterval(() => {
      void this.checkForChanges();
    }, this.options.watchIntervalMs ?? DEFAULT_SERVER_WATCH_INTERVAL_MS);
  }

  current(): LoadedWorkspace {
    const loaded = this.loaded ?? this.invalid;
    if (!loaded) throw new Error('Architecture workspace has not loaded yet.');
    return loaded;
  }

  lastInvalid(): LoadedWorkspace | undefined {
    return this.invalid;
  }

  async reload(reason: string): Promise<void> {
    const next = await loadArchitectureWorkspace(this.options);
    if (hasErrors(next.diagnostics)) {
      this.invalid = next;
      this.events.publish('architecture:invalid', { reason, diagnostics: next.diagnostics });
      return;
    }
    const threadCount = this.loaded?.workspace.threads.length ?? 0;
    this.loaded = next;
    this.invalid = undefined;
    this.events.publish('architecture:model', { reason, summary: next.workspace.manifest.name });
    if (threadCount !== next.workspace.threads.length) {
      this.events.publish('architecture:threads', { reason, count: next.workspace.threads.length });
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async checkForChanges(): Promise<void> {
    const nextFingerprint = await fingerprintDirectory(this.current().workspace.workspaceRoot);
    if (nextFingerprint === this.fingerprint) return;
    this.fingerprint = nextFingerprint;
    await this.reload('file-change');
  }
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
  return values.sort();
}
