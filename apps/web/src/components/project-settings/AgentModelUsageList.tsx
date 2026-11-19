import {
  type AgentModelCatalogEntry,
  formatUsd,
  type ProjectAgentModelSettingsResponse,
} from '@simple-agent-manager/shared';

/** Models listed by name under "Used this month"; any others are counted in one summary line. */
const USED_MODELS_SHOWN = 5;

function callCountLabel(count: number): string {
  return `${count} call${count === 1 ? '' : 's'}`;
}

/** "Used this month": the models with the most spend (the server ranks them), then the rest. */
export function AgentModelUsageList({
  byModel,
  catalogById,
}: {
  byModel: ProjectAgentModelSettingsResponse['usage']['byModel'];
  catalogById: ReadonlyMap<string, AgentModelCatalogEntry>;
}) {
  // Rule 65: a capped list says what it left out.
  const shown = byModel.slice(0, USED_MODELS_SHOWN);
  const others = byModel.slice(USED_MODELS_SHOWN);
  const othersSpentUsd = others.reduce((total, item) => total + item.spentUsd, 0);

  return (
    <div className="grid min-w-0 gap-1">
      <h3 className="m-0 text-sm font-medium text-fg-primary">Used this month</h3>
      {shown.length === 0 ? (
        <p className="m-0 text-xs text-fg-muted">No model calls yet this month.</p>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {shown.map((item) => (
            <li
              key={item.modelId}
              className="flex min-w-0 items-center justify-between gap-2 text-xs"
            >
              <span className="min-w-0 break-words text-fg-primary">
                {catalogById.get(item.modelId)?.name ?? item.modelId}
              </span>
              <span className="shrink-0 tabular-nums text-fg-muted">
                {callCountLabel(item.callCount)} · {formatUsd(item.spentUsd)}
              </span>
            </li>
          ))}
          {others.length > 0 && (
            <li className="flex min-w-0 items-center justify-between gap-2 text-xs text-fg-muted">
              <span className="min-w-0 break-words">
                {others.length} more model{others.length === 1 ? '' : 's'}
              </span>
              <span className="shrink-0 tabular-nums">{formatUsd(othersSpentUsd)}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
