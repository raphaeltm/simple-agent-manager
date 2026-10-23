/**
 * PROTOTYPE "Saved data", used by both takes: the environment's disks in plain words, with
 * add and delete. Provider IDs and device paths stay in "Behind the scenes". A new disk is
 * created where the app runs, so nobody types a provider location code.
 */
import { Button } from '@simple-agent-manager/ui';
import { HardDrive, Plus } from 'lucide-react';
import { useState } from 'react';

import type { DeploymentEnvironment, DeploymentVolume } from '../../../lib/api';
import { Panel, SectionTitle } from '../../automation/ui';
import { useEnvironmentActions } from '../data';
import { TwoStepRemove } from '../shared';

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** 10 GB is the smallest block volume Hetzner and Vultr sell. */
const SIZES = [10, 20, 50, 100, 200];

function AddDisk({ projectId, env, onDone }: { projectId: string; env: DeploymentEnvironment; onDone: () => void }) {
  const actions = useEnvironmentActions(projectId, env.id);
  const [name, setName] = useState('');
  const [size, setSize] = useState(SIZES[0] ?? 10);
  const ok = NAME_RE.test(name.trim());
  return (
    <form
      className="flex flex-col gap-3 border-0 border-b border-solid border-border-default p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ok || !env.location) return;
        actions.addDisk.mutate({ name: name.trim(), sizeGb: size, location: env.location }, { onSuccess: onDone });
      }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold text-fg-primary">Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.currentTarget.value.toLowerCase())}
          placeholder="uploads"
          spellCheck={false}
          className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[15px] text-fg-primary"
        />
        <span className="text-[13px] text-fg-muted">Use the same name as the volume in your Compose file.</span>
      </label>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 text-sm font-semibold text-fg-primary">Size</legend>
        <div className="flex flex-wrap gap-2">
          {SIZES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={size === option}
              onClick={() => setSize(option)}
              className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold ${
                size === option
                  ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                  : 'border-border-default bg-transparent text-fg-muted'
              }`}
            >
              {option} GB
            </button>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ok} loading={actions.addDisk.isPending}>
          Add disk
        </Button>
      </div>
    </form>
  );
}

export function SavedData({
  projectId,
  env,
  volumes,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  volumes: DeploymentVolume[];
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const [adding, setAdding] = useState(false);
  const total = volumes.reduce((sum, volume) => sum + volume.sizeGb, 0);
  return (
    <section id="data" className="flex scroll-mt-4 flex-col gap-3" aria-label="Saved data">
      <SectionTitle
        title="Saved data"
        hint={
          volumes.length === 0
            ? "Disks keep data between deploys. Agents add them from your Compose file's volumes."
            : `${volumes.length} ${volumes.length === 1 ? 'disk' : 'disks'}, ${total} GB. Kept when you pause.`
        }
        action={
          !adding && env.location ? (
            <Button variant="secondary" onClick={() => setAdding(true)} className="shrink-0">
              <Plus size={16} aria-hidden /> Disk
            </Button>
          ) : undefined
        }
      />
      {(volumes.length > 0 || adding) && (
        <Panel className="overflow-hidden">
          {adding && <AddDisk projectId={projectId} env={env} onDone={() => setAdding(false)} />}
          <ul className="m-0 list-none p-0">
            {volumes.map((volume) => (
              <li
                key={volume.id}
                className="flex min-h-14 items-center gap-3 border-0 border-b border-solid border-border-default py-2 pl-4 pr-2 last:border-b-0"
              >
                <HardDrive size={18} aria-hidden className="shrink-0 text-fg-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="break-all text-[15px] font-semibold text-fg-primary">{volume.name}</span>
                  <span className="text-[13px] text-fg-muted">
                    {volume.sizeGb} GB · {volume.attachedServerId ? 'in use by the app' : 'stored, not attached'}
                  </span>
                </span>
                <TwoStepRemove
                  label={`Delete ${volume.name}`}
                  confirm={`Delete ${volume.sizeGb} GB`}
                  busy={actions.removeDisk.isPending}
                  // The API also refuses a disk the newest version declares, attached or not
                  // (deployment-volumes.ts); its error toast says so. NEEDS API: say which up front.
                  disabledReason={
                    volume.attachedServerId
                      ? 'The app uses this disk. To delete it, ship a version without it, or delete the environment.'
                      : undefined
                  }
                  onConfirm={() => actions.removeDisk.mutate(volume.id)}
                />
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </section>
  );
}
