/**
 * PROTOTYPE "Who can deploy", used by both takes.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { ModelToggleSwitch } from '../../../components/agent-models/ModelToggleSwitch';
import type { DeploymentEnvironment } from '../../../lib/api';
import { Panel, SectionTitle } from '../../automation/ui';
import { useEnvironmentActions } from '../data';
import { agentAccess } from '../model';
import { ProfileToggles } from '../shared';

/**
 * One switch, then an explicit "any" or "only these". Today an empty allow-list silently
 * means ANY profile may deploy; unticking the last profile widened access. Here "only
 * these" can never be saved empty.
 */
export function WhoCanDeploy({
  projectId,
  env,
  profiles,
}: {
  projectId: string;
  env: DeploymentEnvironment;
  profiles: AgentProfile[];
}) {
  const actions = useEnvironmentActions(projectId, env.id);
  const access = agentAccess(env, profiles);
  const [wantSome, setWantSome] = useState(access.mode === 'some');
  const busy = actions.setAgentsEnabled.isPending || actions.setAllowedProfiles.isPending;
  const selected = env.agentPolicy.allowedDeployProfileIds;
  const showSome = access.on && (wantSome || access.mode === 'some');

  return (
    <section className="flex flex-col gap-3" aria-label="Who can deploy">
      <SectionTitle title="Who can deploy" />
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-fg-primary">Agents can deploy here</span>
            <span className="text-[13px] text-fg-muted">
              {access.on
                ? 'New versions go live as soon as an agent ships them.'
                : env.latestRelease
                  ? "Off: no new versions. What's running keeps running."
                  : "Off: agents can't deploy here yet."}
            </span>
          </div>
          <ModelToggleSwitch
            checked={access.on}
            disabled={busy}
            label="Agents can deploy here"
            onChange={() => actions.setAgentsEnabled.mutate(!access.on)}
          />
        </div>
        {access.on && (
          <div className="flex flex-col gap-3 border-0 border-t border-solid border-border-default pt-4">
            <div role="radiogroup" aria-label="Which agents" className="flex flex-wrap gap-2">
              {[
                { id: 'any', label: 'Any agent in this project' },
                { id: 'some', label: 'Only these' },
              ].map((option) => {
                const active = (option.id === 'some') === showSome;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={busy}
                    onClick={() => {
                      if (option.id === 'any') {
                        setWantSome(false);
                        if (selected.length > 0) actions.setAllowedProfiles.mutate([]);
                      } else {
                        setWantSome(true);
                      }
                    }}
                    className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm font-semibold ${
                      active
                        ? 'border-accent bg-[var(--sam-color-accent-primary-tint)] text-fg-primary'
                        : 'border-border-default bg-transparent text-fg-muted hover:text-fg-primary'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
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
                <span className="text-[13px] text-fg-muted">
                  {selected.length === 0
                    ? 'Pick at least one profile. Until you do, any agent can still deploy.'
                    : selected.length === 1
                      ? 'Keep at least one. To let everyone deploy, choose “Any agent”.'
                      : `${selected.length} profiles can deploy here.`}
                </span>
              </>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
