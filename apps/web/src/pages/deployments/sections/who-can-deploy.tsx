/**
 * "Who can deploy".
 *
 * An empty allow-list means ANY profile may deploy (`deployment-control.ts`), so a plain
 * on/off switch over the list would grant everyone, and unticking the last profile would
 * widen access instead of closing it. Here turning deploys
 * on is a choice between "any agent" and named profiles, nothing is saved until that
 * choice is made, and "only these" can never be saved empty.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { ModelToggleSwitch } from '../../../components/agent-models/ModelToggleSwitch';
import type { DeploymentEnvironment } from '../../../lib/api';
import { Panel, SectionTitle } from '../../automation/ui';
import { useEnvironmentActions } from '../data';
import { agentAccess, liveVersionOf } from '../model';
import { ProfileToggles } from '../shared';

type Mode = 'any' | 'some';

function ModeChoice({
  value,
  busy,
  onChange,
}: {
  value: Mode | null;
  busy: boolean;
  onChange: (mode: Mode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Which agents" className="flex flex-wrap gap-2">
      {(
        [
          { id: 'any', label: 'Any agent in this project' },
          { id: 'some', label: 'Only these' },
        ] as const
      ).map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          disabled={busy}
          onClick={() => onChange(option.id)}
          className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold ${
            value === option.id
              ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
              : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function WhoCanDeploy({
  projectId,
  env,
  profiles,
  choosing: choosingFromPage = false,
  onChoosingChange,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
  /** Set by a "Let agents deploy here" button elsewhere on the page: open the choice. */
  choosing?: boolean;
  onChoosingChange?: (choosing: boolean) => void;
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const access = agentAccess(env, profiles);
  const [choosingHere, setChoosingHere] = useState(false);
  const choosing = !access.on && (choosingHere || choosingFromPage);
  const setChoosing = (value: boolean) => {
    setChoosingHere(value);
    onChoosingChange?.(value);
  };
  const [wantSome, setWantSome] = useState(access.mode === 'some');
  const [draft, setDraft] = useState<Mode | null>(null);
  const busy =
    actions.setAgentsEnabled.isPending ||
    actions.setAllowedProfiles.isPending ||
    actions.allowAgents.isPending;
  const selected = env.agentPolicy.allowedDeployProfileIds;
  const showSome = access.on && (wantSome || access.mode === 'some');

  return (
    <section id="access" className="flex scroll-mt-4 flex-col gap-3" aria-label="Who can deploy">
      <SectionTitle title="Who can deploy" />
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">
              Agents can deploy here
            </span>
            <span className="text-[13px] text-fg-muted">
              {access.on
                ? 'New versions go live as soon as an agent ships them.'
                : choosing
                  ? 'Choose who first. Nothing changes until you do.'
                  : liveVersionOf(env) !== null
                    ? "Off: no new versions. What's running keeps running."
                    : env.latestRelease
                      ? "Off: agents can't deploy here."
                      : "Off: agents can't deploy here yet."}
            </span>
          </div>
          <ModelToggleSwitch
            checked={access.on || choosing}
            disabled={busy}
            label="Agents can deploy here"
            onChange={() => {
              if (access.on) actions.setAgentsEnabled.mutate(false);
              else setChoosing(!choosing);
            }}
          />
        </div>

        {choosing && (
          <div className="flex flex-col gap-3 border-0 border-t border-solid border-border-default pt-4">
            <ModeChoice
              value={draft}
              busy={busy}
              onChange={(mode) => {
                setDraft(mode);
                if (mode === 'any')
                  actions.allowAgents.mutate([], { onSuccess: () => setChoosing(false) });
              }}
            />
            {draft === 'some' && (
              <ProfileToggles
                profiles={profiles}
                selected={[]}
                disabled={busy}
                onToggle={(id) =>
                  actions.allowAgents.mutate([id], { onSuccess: () => setChoosing(false) })
                }
              />
            )}
          </div>
        )}

        {access.on && (
          <div className="flex flex-col gap-3 border-0 border-t border-solid border-border-default pt-4">
            <ModeChoice
              value={showSome ? 'some' : 'any'}
              busy={busy}
              onChange={(mode) => {
                if (mode === 'any') {
                  setWantSome(false);
                  if (selected.length > 0) actions.setAllowedProfiles.mutate([]);
                } else {
                  setWantSome(true);
                }
              }}
            />
            {showSome && (
              <>
                <ProfileToggles
                  profiles={profiles}
                  selected={selected}
                  disabled={busy}
                  onToggle={(id) => {
                    const next = selected.includes(id)
                      ? selected.filter((item) => item !== id)
                      : [...selected, id];
                    if (next.length > 0) actions.setAllowedProfiles.mutate(next);
                  }}
                />
                {selected.length === 0 ? (
                  <span className="flex items-start gap-2 rounded-lg bg-warning-tint px-3 py-2 text-[13px] font-medium text-warning-fg">
                    <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0" />
                    Pick at least one profile. Until you do, any agent can still deploy here.
                  </span>
                ) : (
                  <span className="text-[13px] text-fg-muted">
                    {selected.length === 1
                      ? 'Keep at least one. To let everyone deploy, choose “Any agent”.'
                      : `${selected.length} profiles can deploy here.`}
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
