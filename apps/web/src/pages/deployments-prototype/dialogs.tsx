/**
 * PROTOTYPE dialogs both takes open: logs, add a domain, pause, delete.
 */
import { Button, Dialog } from '@simple-agent-manager/ui';
import { Check, Copy, Search } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import type { DeploymentEnvironment, DeploymentPublicRoute, DeploymentVolume } from '../../lib/api';
import { Chips } from '../automation/ui';
import { type LogFilter, useEnvironmentActions, useLogs } from './data';
import { CopyIcon, LogList } from './shared';

/**
 * Keeps a sheet's buttons on screen while its body scrolls: phones are shorter than the
 * create and add-domain sheets, and the button that finishes them must not hide below.
 */
export const STICKY_FOOTER =
  'sticky bottom-[-24px] z-[1] -mx-6 -mb-6 flex flex-wrap justify-end gap-3 border-0 border-t border-solid border-border-default bg-[var(--sam-color-bg-surface)] px-6 pb-6 pt-4';

/** Why there are no log lines, from the reasons the logs route returns. */
export function unavailableLogs(reason: string | undefined): string {
  if (reason === 'no_deployment_node') return 'No server is running this app, so there are no logs.';
  if (reason === 'node_not_running') return "The server isn't running, so there are no fresh logs.";
  if (reason === 'node_not_found') return 'The server is gone, so its logs are too.';
  if (reason === 'node_agent_unreachable') return "SAM can't reach the server right now, so no fresh logs.";
  return 'Nothing logged for this filter yet.';
}

const LOG_FILTERS: Array<{ id: LogFilter; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'errors', label: 'Errors' },
  { id: 'app', label: 'Your app' },
  { id: 'sam', label: 'SAM' },
];

export function LogsDialog({
  projectId,
  env,
  open,
  onClose,
  initialFilter = 'all',
}: {
  projectId: string;
  env: DeploymentEnvironment;
  open: boolean;
  onClose: () => void;
  initialFilter?: LogFilter;
}) {
  const [filter, setFilter] = useState<LogFilter>(initialFilter);
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const logs = useLogs(projectId, env.id, filter, open, search);
  const entries = logs.data?.entries ?? [];
  const text = entries.map((entry) => `${entry.timestamp} [${entry.level}] [${entry.source}] ${entry.message}`).join('\n');
  return (
    <Dialog isOpen={open} onClose={onClose} maxWidth="lg" aria-label={`Logs for ${env.name}`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">Logs</h2>
          <p className="m-0 text-sm text-fg-muted">
            The newest lines from {env.name}. Your app's own output, plus what SAM did on the server.
          </p>
        </div>
        <Chips options={LOG_FILTERS} value={filter} onChange={setFilter} label="Show" wrap />
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(typed.trim());
          }}
        >
          <span className="relative flex min-w-0 flex-1 items-center">
            <Search size={15} aria-hidden className="pointer-events-none absolute left-3 text-fg-muted" />
            <input
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
              placeholder="Search the logs"
              aria-label="Search the logs"
              className="min-h-11 w-full min-w-0 rounded-md border border-border-default bg-surface pl-9 pr-3 text-[14px] text-fg-primary"
            />
          </span>
          {entries.length > 0 && <CopyIcon label="these log lines" value={text} />}
        </form>
        {logs.isPending ? (
          <p className="m-0 text-sm text-fg-muted">Loading logs…</p>
        ) : (
          <LogList
            entries={entries}
            empty={unavailableLogs(logs.data?.unavailableReason)}
          />
        )}
      </div>
    </Dialog>
  );
}

function RecordRow({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-0 border-b border-solid border-border-default py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="text-[12px] text-fg-muted">{label}</span>
        <span className="min-w-0 break-all font-mono text-[13px] text-fg-primary">{value}</span>
      </div>
      {copyable && (
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => toast.error('Copy failed. Select the text instead.')
            );
          }}
          className="inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border-default bg-transparent px-3 text-sm font-medium text-fg-primary hover:bg-surface-hover"
        >
          {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
}

/** Three steps in one sheet: which part of the app, which domain, which DNS record. */
export function AddDomainDialog({
  projectId,
  env,
  routes,
  open,
  onClose,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  routes: DeploymentPublicRoute[];
  open: boolean;
  onClose: () => void;
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const [routeId, setRouteId] = useState(routes[0]?.id ?? '');
  const [hostname, setHostname] = useState('');
  const route = routes.find((item) => item.id === routeId) ?? routes[0];
  const clean = hostname.trim().toLowerCase();
  const valid = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) && clean.split('.').length >= 3;
  const options = routes.map((item) => ({ id: item.id, label: item.service }));

  return (
    <Dialog isOpen={open} onClose={onClose} maxWidth="lg" aria-label="Add your own domain">
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!route || !valid) return;
          actions.addDomain.mutate(
            { service: route.service, port: route.port, hostname: clean },
            { onSuccess: onClose }
          );
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">Use your own domain</h2>
          <p className="m-0 text-sm text-fg-muted">
            Point a subdomain you own at this app. SAM sets up HTTPS for it, with no redeploy.
          </p>
        </div>

        {routes.length > 1 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm font-semibold text-fg-primary">
              1. Which part of the app?
            </legend>
            <Chips options={options} value={routeId} onChange={setRouteId} label="Part of the app" wrap />
          </fieldset>
        )}

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-fg-primary">
            {routes.length > 1 ? '2. ' : '1. '}Your domain
          </span>
          <input
            value={hostname}
            onChange={(event) => setHostname(event.currentTarget.value)}
            placeholder="shop.example.com"
            spellCheck={false}
            autoCapitalize="none"
            className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[15px] text-fg-primary"
          />
          <span className="text-[13px] text-fg-muted">
            A subdomain such as shop.example.com. Bare domains (example.com) aren't supported yet.
          </span>
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-fg-primary">
            {routes.length > 1 ? '3. ' : '2. '}Add this record where you manage DNS
          </span>
          <div className="rounded-lg border border-border-default bg-inset px-4">
            <RecordRow label="Type" value="CNAME" />
            <RecordRow label="Name" value={valid ? clean : 'shop.example.com'} copyable={valid} />
            <RecordRow label="Points to" value={route?.hostname ?? ''} copyable />
          </div>
          <span className="text-[13px] text-fg-muted">
            On Cloudflare, switch the orange cloud off for this record (DNS only). SAM checks the
            record when you add the domain. If DNS hasn't caught up yet, use Check again later.
          </span>
        </div>

        <div className={STICKY_FOOTER}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={actions.addDomain.isPending}>
            Add domain and check DNS
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function volumeSummary(volumes: DeploymentVolume[]): string {
  const total = volumes.reduce((sum, volume) => sum + volume.sizeGb, 0);
  return `${volumes.length} ${volumes.length === 1 ? 'disk' : 'disks'} (${total} GB) of saved data`;
}

export function PauseDialog({
  env,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  env: DeploymentEnvironment;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog isOpen={open} onClose={onClose} aria-label={`Pause ${env.name}`}>
      <div className="flex flex-col gap-4">
        <h2 className="m-0 text-[19px] font-semibold text-fg-primary">Pause {env.name}?</h2>
        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[15px] text-fg-primary marker:text-fg-muted">
          <li>The app stops and its addresses stop answering.</li>
          <li>Its server is removed if no other app is using it.</li>
          <li>Settings, domains and disks are kept. Your cloud still bills for the disks.</li>
        </ul>
        <p className="m-0 text-sm text-fg-muted">
          Start it again any time: SAM puts the latest version back on a server, with your saved data.
        </p>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Keep it running
          </Button>
          <Button onClick={onConfirm} loading={busy}>
            Pause
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function DeleteDialog({
  env,
  siblings,
  volumes,
  domainCount,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  env: DeploymentEnvironment;
  siblings: number;
  volumes: DeploymentVolume[];
  domainCount: number;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === env.name;
  return (
    <Dialog isOpen={open} onClose={onClose} aria-label={`Delete ${env.name}`}>
      <div className="flex flex-col gap-4">
        <h2 className="m-0 break-words text-[19px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
          Delete {env.name}?
        </h2>
        <p className="m-0 text-[15px] text-fg-primary">This removes, for good:</p>
        <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[15px] text-fg-primary marker:text-fg-muted">
          <li>The app and its version history</li>
          {domainCount > 0 && (
            <li>
              {domainCount} custom {domainCount === 1 ? 'domain' : 'domains'} (your DNS records stay
              where they are)
            </li>
          )}
          {volumes.length > 0 && <li>{volumeSummary(volumes)}</li>}
          <li>
            {siblings > 1
              ? 'Not the server: other apps still use it'
              : env.node
                ? 'Its server, unless another app is using it'
                : 'Nothing else: no server is running'}
          </li>
        </ul>
        <label className="flex flex-col gap-2">
          <span className="text-sm text-fg-muted">
            Type <strong className="break-all text-fg-primary">{env.name}</strong> to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.currentTarget.value)}
            spellCheck={false}
            autoCapitalize="none"
            className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[15px] text-fg-primary"
          />
        </label>
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!matches} loading={busy} onClick={onConfirm}>
            Delete forever
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
