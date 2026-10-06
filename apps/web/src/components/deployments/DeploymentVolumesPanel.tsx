import { Alert, Button, StatusBadge } from '@simple-agent-manager/ui';
import { HardDrive, Link2, Plus, RefreshCw, Trash2, Unlink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useToast } from '../../hooks/useToast';
import {
  attachDeploymentEnvironmentVolumes,
  createDeploymentEnvironmentVolume,
  deleteDeploymentEnvironmentVolume,
  type DeploymentVolume,
  detachDeploymentEnvironmentVolumes,
  listDeploymentEnvironmentVolumes,
} from '../../lib/api';
import { formatDateTimeCompact } from './deployment-card-format';

const VOLUME_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

interface Props {
  projectId: string;
  environmentId: string;
  defaultLocation: string;
  hasLinkedNode: boolean;
}

function formatServer(value: string | null): string {
  if (!value) return 'Detached';
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function attachmentLabel(volume: DeploymentVolume): string {
  return volume.attachedServerId ? 'Attached' : 'Detached';
}

function totalSizeGb(volumes: DeploymentVolume[]): number {
  return volumes.reduce((sum, volume) => sum + volume.sizeGb, 0);
}

export function DeploymentVolumesPanel({
  projectId,
  environmentId,
  defaultLocation,
  hasLinkedNode,
}: Props) {
  const toast = useToast();
  const [volumes, setVolumes] = useState<DeploymentVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [sizeGb, setSizeGb] = useState('1');
  const [location, setLocation] = useState(defaultLocation);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!location && defaultLocation) setLocation(defaultLocation);
  }, [defaultLocation, location]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listDeploymentEnvironmentVolumes(projectId, environmentId);
      setVolumes(result.volumes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deployment volumes');
    } finally {
      setLoading(false);
    }
  }, [environmentId, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const attachedCount = useMemo(
    () => volumes.filter((volume) => Boolean(volume.attachedServerId)).length,
    [volumes]
  );
  const providerSummary = useMemo(() => {
    const providers = [...new Set(volumes.map((volume) => volume.providerName))];
    return providers.length === 0 ? 'None' : providers.join(', ');
  }, [volumes]);

  const createVolume = async () => {
    const trimmedName = name.trim();
    const trimmedLocation = location.trim();
    const parsedSize = Number(sizeGb);
    if (!VOLUME_NAME_RE.test(trimmedName)) {
      setFormError('Name must be lowercase alphanumeric with optional hyphens, 1-63 chars.');
      return;
    }
    if (!Number.isInteger(parsedSize) || parsedSize < 1) {
      setFormError('Size must be a whole number of GB.');
      return;
    }
    if (!trimmedLocation) {
      setFormError('Location is required.');
      return;
    }

    setBusy('create');
    setFormError(null);
    try {
      const created = await createDeploymentEnvironmentVolume(projectId, environmentId, {
        name: trimmedName,
        sizeGb: parsedSize,
        location: trimmedLocation,
      });
      setVolumes((current) => {
        const withoutExisting = current.filter((volume) => volume.id !== created.id);
        return [...withoutExisting, created].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
      setName('');
      setSizeGb('1');
      toast.success('Volume created');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create volume');
    } finally {
      setBusy(null);
    }
  };

  const deleteVolume = async (volume: DeploymentVolume) => {
    if (!window.confirm(`Delete volume ${volume.name}? Stored data will be destroyed.`)) return;
    setBusy(`delete:${volume.id}`);
    setError(null);
    try {
      await deleteDeploymentEnvironmentVolume(projectId, environmentId, volume.id);
      setVolumes((current) => current.filter((item) => item.id !== volume.id));
      toast.success('Volume deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete volume');
    } finally {
      setBusy(null);
    }
  };

  const attachAll = async () => {
    setBusy('attach');
    setError(null);
    try {
      const result = await attachDeploymentEnvironmentVolumes(projectId, environmentId);
      setVolumes(result.volumes);
      toast.success('Volumes attached');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to attach volumes');
    } finally {
      setBusy(null);
    }
  };

  const detachAll = async () => {
    setBusy('detach');
    setError(null);
    try {
      const result = await detachDeploymentEnvironmentVolumes(projectId, environmentId);
      setVolumes(result.volumes);
      toast.success('Volumes detached');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detach volumes');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <section className="rounded-md border border-border-default bg-inset px-3 py-3 text-sm text-fg-muted">
        Loading volumes...
      </section>
    );
  }

  return (
    <section id={`deployment-volumes-${environmentId}`} className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Volumes" value={String(volumes.length)} />
        <Metric label="Attached" value={`${attachedCount}/${volumes.length}`} />
        <Metric label="Size" value={`${totalSizeGb(volumes)} GB`} />
        <Metric label="Provider" value={providerSummary} />
      </div>

      {error && (
        <Alert variant="error" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2 text-fg-primary font-semibold text-sm">
          <HardDrive size={15} />
          Volumes
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            <RefreshCw size={14} />
            Refresh
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void attachAll()}
            loading={busy === 'attach'}
            disabled={!hasLinkedNode || volumes.length === 0 || busy !== null}
          >
            <Link2 size={14} />
            Attach
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void detachAll()}
            loading={busy === 'detach'}
            disabled={!hasLinkedNode || attachedCount === 0 || busy !== null}
          >
            <Unlink size={14} />
            Detach
          </Button>
        </div>
      </div>

      <section className="rounded-md border border-border-default bg-inset px-3 py-3 grid gap-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_minmax(0,180px)_auto] sm:items-end">
          <label className="grid gap-1 text-xs text-fg-muted min-w-0">
            Name
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-surface text-fg-primary text-[0.8125rem] font-[inherit] box-border"
              placeholder="data"
            />
          </label>
          <label className="grid gap-1 text-xs text-fg-muted min-w-0">
            Size
            <input
              value={sizeGb}
              onChange={(event) => setSizeGb(event.currentTarget.value)}
              className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-surface text-fg-primary text-[0.8125rem] font-[inherit] box-border"
              inputMode="numeric"
              min={1}
              type="number"
            />
          </label>
          <label className="grid gap-1 text-xs text-fg-muted min-w-0">
            Location
            <input
              value={location}
              onChange={(event) => setLocation(event.currentTarget.value)}
              className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-surface text-fg-primary text-[0.8125rem] font-[inherit] box-border"
              placeholder="location"
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void createVolume()}
            loading={busy === 'create'}
            disabled={busy !== null}
          >
            <Plus size={14} />
            Add
          </Button>
        </div>
        {formError && <div className="text-xs text-danger break-words">{formError}</div>}
      </section>

      {volumes.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-default bg-inset px-3 py-6 text-center text-sm text-fg-muted">
          No volumes created for this environment.
        </div>
      ) : (
        <div className="grid gap-2">
          {volumes.map((volume) => (
            <VolumeRow
              key={volume.id}
              volume={volume}
              deleting={busy === `delete:${volume.id}`}
              busy={busy !== null}
              onDelete={() => void deleteVolume(volume)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-default bg-inset px-3 py-2 min-w-0">
      <div className="text-[0.68rem] uppercase font-semibold text-fg-muted">{label}</div>
      <div className="text-sm font-semibold text-fg-primary truncate">{value}</div>
    </div>
  );
}

function VolumeRow({
  volume,
  deleting,
  busy,
  onDelete,
}: {
  volume: DeploymentVolume;
  deleting: boolean;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <article className="rounded-md border border-border-default bg-surface px-3 py-3 grid gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 grid gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-fg-primary break-all">{volume.name}</span>
            <StatusBadge
              status={volume.attachedServerId ? 'connected' : 'pending'}
              label={attachmentLabel(volume)}
            />
            <StatusBadge status={volume.status} label={volume.status} />
          </div>
          <div className="text-xs text-fg-muted break-words">
            {volume.providerName} / {volume.location} / {volume.sizeGb} GB
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          loading={deleting}
          disabled={busy || Boolean(volume.attachedServerId)}
          aria-label={`Delete volume ${volume.name}`}
          title={volume.attachedServerId ? 'Detach before deleting' : `Delete ${volume.name}`}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-5 text-xs">
        <div className="min-w-0">
          <dt className="text-fg-muted">Provider ID</dt>
          <dd className="m-0 font-mono text-fg-primary break-all">{volume.providerVolumeId}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-muted">Server</dt>
          <dd className="m-0 font-mono text-fg-primary break-all">
            {formatServer(volume.attachedServerId)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-muted">Device</dt>
          <dd className="m-0 font-mono text-fg-primary break-all">{volume.linuxDevice ?? '-'}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-muted">Created</dt>
          <dd className="m-0 text-fg-primary">{formatDateTimeCompact(volume.createdAt)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-fg-muted">Updated</dt>
          <dd className="m-0 text-fg-primary">{formatDateTimeCompact(volume.updatedAt)}</dd>
        </div>
      </dl>
    </article>
  );
}
