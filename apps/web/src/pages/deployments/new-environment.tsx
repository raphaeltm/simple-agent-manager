/**
 * The "New environment" sheet.
 *
 * Creating an environment is rare, so it is a button that opens this sheet rather than a
 * form above every environment. The sheet asks the one
 * question that matters before anything can deploy: which agents may ship here. There is
 * no default answer, so nobody gets deploy access by accident.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { useCreateEnvironment } from './data';
import { STICKY_FOOTER } from './dialogs';
import { ProfileToggles } from './shared';

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SUGGESTIONS = ['staging', 'production', 'preview'];

type Access = 'any' | 'some' | 'off';

const ACCESS_OPTIONS: Array<{ id: Access; title: string; body: string }> = [
  { id: 'any', title: 'Any agent in this project', body: 'Good for previews and staging.' },
  { id: 'some', title: 'Only some agent profiles', body: 'Good for production.' },
  { id: 'off', title: 'Nobody yet', body: 'Turn it on later from the environment.' },
];

export function NewEnvironmentDialog({
  projectId,
  profiles,
  existing,
  open,
  onClose,
  onCreated,
}: {
  projectId: string;
  profiles: AgentProfile[];
  existing: string[];
  open: boolean;
  onClose: () => void;
  onCreated: (envId: string) => void;
}) {
  const create = useCreateEnvironment(projectId);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<Access | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const clean = name.trim();
  const taken = existing.includes(clean);
  const nameError =
    clean && !NAME_RE.test(clean)
      ? 'Use lowercase letters, numbers and dashes.'
      : taken
        ? 'That name is already used in this project.'
        : null;
  const ready =
    Boolean(clean) && !nameError && access !== null && (access !== 'some' || chosen.length > 0);

  return (
    <Dialog isOpen={open} onClose={onClose} maxWidth="lg" aria-label="New environment">
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || access === null) return;
          create.mutate(
            { name: clean, agents: access === 'some' ? chosen : access },
            { onSuccess: (env) => onCreated(env.id) }
          );
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">New environment</h2>
          <p className="m-0 text-sm text-fg-muted">
            A place for one running copy of your app. Nothing runs, and nothing costs money, until
            an agent deploys to it.
          </p>
        </div>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-fg-primary">Name</span>
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value.toLowerCase())}
            placeholder="staging"
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={Boolean(nameError)}
            className="min-h-11 rounded-md border border-border-default bg-surface px-3 text-[15px] text-fg-primary"
          />
          {nameError ? (
            <span className="text-[13px] text-danger-fg">{nameError}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
              Try
              {SUGGESTIONS.filter((item) => !existing.includes(item)).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setName(item)}
                  className="inline-flex min-h-9 cursor-pointer items-center rounded-full border border-border-default bg-transparent px-3 text-[13px] font-medium text-fg-primary hover:bg-surface-hover"
                >
                  {item}
                </button>
              ))}
            </span>
          )}
        </label>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-sm font-semibold text-fg-primary">
            Which agents can deploy here?
          </legend>
          {ACCESS_OPTIONS.map((option) => (
            <label
              key={option.id}
              className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 ${
                access === option.id
                  ? 'border-accent bg-[var(--sam-color-accent-primary-tint)]'
                  : 'border-border-default hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name="access"
                checked={access === option.id}
                onChange={() => setAccess(option.id)}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--sam-color-accent-primary)]"
              />
              <span className="flex flex-col">
                <span className="text-[15px] font-semibold text-fg-primary">{option.title}</span>
                <span className="text-[13px] text-fg-muted">{option.body}</span>
              </span>
            </label>
          ))}
          {access === 'some' && (
            <div className="flex flex-col gap-2 pt-1">
              <span className="text-[13px] text-fg-muted">Pick at least one:</span>
              <ProfileToggles
                profiles={profiles}
                selected={chosen}
                onToggle={(id) =>
                  setChosen((current) =>
                    current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
                  )
                }
              />
            </div>
          )}
        </fieldset>

        <div className={STICKY_FOOTER}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready} loading={create.isPending}>
            Create environment
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
