/**
 * PROTOTYPE: "bring your own machine" (user-owned nodes) UX exploration.
 * Unauthed, mock data only, no API calls. Never merge to main (rule 37).
 *
 * Deep links for screenshots: /prototype/byo-machine?scene=nodes|add|machine|terminal|runs
 *   nodes:    &data=normal|many|empty
 *   add:      &step=name|command|connected|expired|reconnect
 *   machine:  &state=online|paused|offline|reconnect|updating
 *   terminal: &term=install|failed|reconnect|status|uninstall|today
 *   any:      &chrome=0 hides the prototype switcher
 */
import { Button, EmptyState, Pane, SegmentedControl } from '@simple-agent-manager/ui';
import { HardDrive } from 'lucide-react';
import { useSearchParams } from 'react-router';

import { AddMachineSheet, type AddStep } from './add-machine-sheet';
import { CloudNodeCard, MachineCard } from './machine-card';
import { MachinePage } from './machine-page';
import {
  CLOUD_NODES,
  MACHINE_BY_STATE,
  type MachineState,
  MANY_MACHINES,
  type MockMachine,
  NORMAL_MACHINES,
  type TerminalVariant,
} from './mock-data';
import { PlacementScene, TerminalScene } from './scenes';

type Scene = 'nodes' | 'add' | 'machine' | 'terminal' | 'runs';
type DataSet = 'normal' | 'many' | 'empty';

const SCENES: Array<{ value: Scene; label: string }> = [
  { value: 'nodes', label: 'Nodes' },
  { value: 'add', label: 'Add' },
  { value: 'machine', label: 'Machine' },
  { value: 'terminal', label: 'CLI' },
  { value: 'runs', label: 'Runs' },
];

const VARIANTS: Record<Scene, { key: string; options: Array<{ value: string; label: string }> }> = {
  nodes: {
    key: 'data',
    options: [
      { value: 'normal', label: 'Typical' },
      { value: 'many', label: 'Every state' },
      { value: 'empty', label: 'Empty' },
    ],
  },
  add: {
    key: 'step',
    options: [
      { value: 'name', label: '1 Name' },
      { value: 'command', label: '2 Command' },
      { value: 'connected', label: '3 Online' },
      { value: 'expired', label: 'Expired' },
    ],
  },
  machine: {
    key: 'state',
    options: [
      { value: 'online', label: 'Online' },
      { value: 'paused', label: 'Paused' },
      { value: 'offline', label: 'Offline' },
      { value: 'reconnect', label: 'Reconnect' },
      { value: 'updating', label: 'Updating' },
    ],
  },
  terminal: {
    key: 'term',
    options: [
      { value: 'install', label: 'Install' },
      { value: 'failed', label: 'Fails' },
      { value: 'reconnect', label: 'Reconnect' },
      { value: 'status', label: 'Status' },
      { value: 'uninstall', label: 'Uninstall' },
      { value: 'today', label: 'Today' },
    ],
  },
  runs: { key: '', options: [] },
};

const MACHINE_SETS: Record<DataSet, MockMachine[]> = {
  normal: NORMAL_MACHINES,
  many: MANY_MACHINES,
  empty: [],
};

function NodesScene({
  machines,
  onAdd,
  onOpen,
  onAction,
}: {
  machines: MockMachine[];
  onAdd: () => void;
  onOpen: (machine: MockMachine) => void;
  onAction: (action: 'command' | 'reconnect') => void;
}) {
  const online = machines.filter((m) => m.state === 'online' || m.state === 'updating').length;
  return (
    <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">
      <Pane
        variant="slab"
        as="header"
        className="flex min-w-0 flex-wrap items-start justify-between gap-3 p-4"
      >
        <div className="min-w-0 flex-1 basis-[240px]">
          <h1 className="m-0 text-[24px] font-bold text-fg-primary">Nodes</h1>
          <p className="sam-type-secondary m-0 mt-1 text-fg-muted">
            The machines your agents run on: your own, and cloud machines SAM starts for you.
          </p>
        </div>
        <Button variant="primary" onClick={onAdd}>
          Add a machine
        </Button>
      </Pane>

      <section aria-labelledby="yours" className="flex min-w-0 flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <h2
            id="yours"
            className="m-0 text-[13px] font-semibold uppercase tracking-wide text-fg-muted"
          >
            Your machines
          </h2>
          {machines.length > 0 && (
            <span className="font-mono text-[11px] text-fg-muted">
              {online} online ·{' '}
              {machines.length <= 5 ? `${machines.length} of 5` : `${machines.length} machines`}
            </span>
          )}
        </div>
        {machines.length === 0 ? (
          <Pane className="p-2">
            <EmptyState
              icon={<HardDrive size={44} />}
              heading="Run agents on a computer you own"
              description="A home server, an office workstation, a GPU box. One command connects it. It costs nothing to run here, and no ports need opening."
              action={{ label: 'Add a machine', onClick: onAdd }}
            />
          </Pane>
        ) : (
          <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] xl:grid-cols-2">
            {machines.map((machine) => (
              <MachineCard key={machine.id} machine={machine} onOpen={onOpen} onAction={onAction} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="cloud" className="flex min-w-0 flex-col gap-2.5">
        <h2
          id="cloud"
          className="m-0 px-1 text-[13px] font-semibold uppercase tracking-wide text-fg-muted"
        >
          Cloud machines
        </h2>
        <div className="grid grid-cols-1 items-start gap-[var(--sam-space-gutter)] xl:grid-cols-2">
          {CLOUD_NODES.map((node) => (
            <CloudNodeCard key={node.id} node={node} />
          ))}
        </div>
      </section>
    </div>
  );
}

export function ByoMachinePrototype() {
  const [params, setParams] = useSearchParams();
  const scene = (SCENES.find((s) => s.value === params.get('scene'))?.value ?? 'nodes') as Scene;
  const variantSpec = VARIANTS[scene];
  const variant =
    variantSpec.options.find((o) => o.value === params.get(variantSpec.key))?.value ??
    variantSpec.options[0]?.value ??
    '';
  const go = (next: Scene, key?: string, value?: string) =>
    setParams(key && value ? { scene: next, [key]: value } : { scene: next });

  // &chrome=0 hides the prototype switcher, for clean screenshots.
  const showControls = params.get('chrome') !== '0';
  const machines = MACHINE_SETS[scene === 'nodes' ? (variant as DataSet) : 'normal'];

  return (
    // Own scroll container: the app does not scroll at the body level (rule 37).
    <div className="sam-void relative" style={{ height: '100vh', overflow: 'auto' }}>
      <div className="mx-auto flex w-full min-w-0 max-w-[72rem] flex-col gap-[var(--sam-space-gutter)] p-3 md:p-4">
        {showControls && (
          <Pane
            variant="quiet"
            className="flex min-w-0 flex-col gap-2 p-2.5"
            data-testid="prototype-controls"
          >
            <span className="font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
              Prototype · mock data
            </span>
            {/* Prototype chrome only: scrolls sideways on a phone instead of truncating labels. */}
            <div className="relative min-w-0 overflow-x-auto">
              <SegmentedControl
                label="Screen"
                options={SCENES}
                value={scene}
                onChange={(next) => go(next)}
                className="w-max min-w-full"
              />
            </div>
            {variantSpec.options.length > 0 && (
              <div className="relative min-w-0 overflow-x-auto">
                <SegmentedControl
                  label="Variant"
                  options={variantSpec.options}
                  value={variant}
                  onChange={(next) => go(scene, variantSpec.key, next)}
                  className="w-max min-w-full"
                />
              </div>
            )}
          </Pane>
        )}

        {(scene === 'nodes' || scene === 'add') && (
          <NodesScene
            machines={machines}
            onAdd={() => go('add', 'step', 'name')}
            onOpen={(machine) => go('machine', 'state', machine.state)}
            onAction={(action) =>
              go('add', 'step', action === 'reconnect' ? 'reconnect' : 'command')
            }
          />
        )}
        {scene === 'add' && (
          <AddMachineSheet
            step={(params.get('step') as AddStep) ?? 'name'}
            onStep={(next) => go('add', 'step', next)}
            onClose={() => go('nodes')}
          />
        )}
        {scene === 'machine' && (
          <MachinePage
            key={variant}
            machine={MACHINE_BY_STATE[variant as MachineState] ?? MACHINE_BY_STATE.online}
            onBack={() => go('nodes')}
            onReconnect={() => go('add', 'step', 'reconnect')}
          />
        )}
        {scene === 'terminal' && <TerminalScene variant={variant as TerminalVariant} />}
        {scene === 'runs' && <PlacementScene />}
      </div>
    </div>
  );
}
