/**
 * The project-first view: which account each project uses for each provider.
 * A table on desktop; one card per project on phones.
 */
import { AlertTriangle, Pin, Sparkles, Star } from 'lucide-react';
import { Link } from 'react-router';

import {
  type AccountProject,
  isProviderInUse,
  type ProjectResolution,
  type ProviderAccounts,
} from './account-model';
import { ProviderMark } from './AccountBits';

export interface AccountsByProjectProps {
  groups: ProviderAccounts[];
  projects: AccountProject[];
}

export function AccountsByProject({ groups, projects }: Readonly<AccountsByProjectProps>) {
  const columns = groups.filter(isProviderInUse);
  if (projects.length === 0 || columns.length === 0) {
    return (
      <p className="m-0 rounded-lg border border-dashed border-border-default p-4 text-center text-sm text-fg-muted">
        {projects.length === 0
          ? 'No projects yet — once you create one, this shows which account it uses.'
          : 'Connect an account to see which projects use it.'}
      </p>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-border-default bg-surface md:block">
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-left">
          <thead>
            <tr className="bg-inset">
              <th className="w-[32%] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                Project
              </th>
              {columns.map((group) => (
                <th key={group.provider.id} className="px-3 py-2.5">
                  <span className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-fg-primary">
                    <ProviderMark provider={group.provider} size={20} />
                    <span className="truncate">{group.provider.name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-t border-border-default">
                <td className="px-4 py-2">
                  <Link
                    to={`/projects/${project.id}/settings/accounts`}
                    className="block truncate text-xs font-medium text-fg-primary no-underline hover:text-accent"
                    title={project.name}
                  >
                    {project.name}
                  </Link>
                </td>
                {columns.map((group) => (
                  <td key={group.provider.id} className="px-3 py-2">
                    <ResolutionCell resolution={group.resolutions.get(project.id)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
        {projects.map((project) => (
          <li
            key={project.id}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-default bg-surface p-3"
          >
            <Link
              to={`/projects/${project.id}/settings/accounts`}
              className="min-w-0 text-sm font-semibold text-fg-primary no-underline line-clamp-2 break-words [overflow-wrap:anywhere] hover:text-accent"
            >
              {project.name}
            </Link>
            {columns.map((group) => (
              <span
                key={group.provider.id}
                className="flex min-w-0 items-center justify-between gap-2"
              >
                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
                  <ProviderMark provider={group.provider} size={18} />
                  {group.provider.name}
                </span>
                <ResolutionCell resolution={group.resolutions.get(project.id)} />
              </span>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

function ResolutionCell({ resolution }: Readonly<{ resolution: ProjectResolution | undefined }>) {
  if (!resolution || resolution.source === 'none') {
    return <span className="text-[11px] text-fg-muted">— no account</span>;
  }
  if (resolution.source === 'platform') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-fg-muted">
        <Sparkles size={11} aria-hidden="true" className="shrink-0" />
        <span className="truncate">SAM platform</span>
      </span>
    );
  }
  if (resolution.source === 'blocked') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-danger-fg">
        <AlertTriangle size={11} aria-hidden="true" className="shrink-0" />
        <span className="truncate">Paused pin — can’t run</span>
      </span>
    );
  }
  const { account } = resolution;
  return (
    <span
      title={account.label}
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border-default px-1.5 py-0.5 text-[11px] text-fg-primary"
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: account.swatch }}
      />
      {resolution.source === 'pinned' ? (
        <Pin size={10} aria-label="Pinned" className="shrink-0 text-info-fg" />
      ) : (
        <Star
          size={10}
          aria-label="Default"
          fill="currentColor"
          className="shrink-0 text-success-fg"
        />
      )}
      <span className="min-w-0 truncate">{account.label}</span>
    </span>
  );
}
