import type { TriggerResponse } from '@simple-agent-manager/shared';

interface TriggerConfigurationProps {
  trigger: TriggerResponse;
}

function formatDateFull(date: string): string {
  return new Date(date).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

function sourceRows(trigger: TriggerResponse): Array<[string, string]> {
  if (trigger.sourceType === 'github') {
    return [
      ['GitHub Event', trigger.githubConfig?.eventType?.replace(/_/g, ' ') ?? '—'],
      ['Actions', trigger.githubConfig?.filters.actions?.join(', ') ?? 'Any'],
      ['Required Labels', trigger.githubConfig?.filters.labels?.join(', ') ?? 'None'],
      ['Command Prefix', trigger.githubConfig?.filters.commandPrefix ?? 'None'],
      ['Branches', trigger.githubConfig?.filters.branches?.join(', ') ?? 'Any'],
      ['Ignored Actors', trigger.githubConfig?.filters.ignoreActors?.join(', ') ?? 'None'],
    ];
  }
  if (trigger.sourceType === 'webhook') {
    return [
      ['Source Label', trigger.webhookConfig?.sourceLabel ?? 'None'],
      ['Token', `••••${trigger.webhookConfig?.tokenLastFour ?? '—'}`],
      ['Filter Mode', trigger.webhookConfig?.filterMode ?? 'all'],
      ['Filters', String(trigger.webhookConfig?.filters.length ?? 0)],
      ['Included Headers', trigger.webhookConfig?.includedHeaders.join(', ') || 'None'],
    ];
  }
  return [
    ['Schedule', trigger.cronHumanReadable ?? trigger.cronExpression ?? '—'],
    ['Timezone', trigger.cronTimezone],
  ];
}

export function TriggerConfiguration({ trigger }: TriggerConfigurationProps) {
  const rows: Array<[string, string]> = [
    ['Source Type', trigger.sourceType],
    ...sourceRows(trigger),
    ['Task Mode', trigger.taskMode],
    ['Skip if Running', trigger.skipIfRunning ? 'Yes' : 'No'],
    ['Max Concurrent', String(trigger.maxConcurrent)],
    ['VM Size', trigger.vmSizeOverride ?? 'Project default'],
    ['Total Runs', String(trigger.triggerCount)],
    ['Created', formatDateFull(trigger.createdAt)],
  ];

  return (
    <section className="mt-8">
      <h2 className="sam-type-section-heading mb-4">Configuration</h2>
      <div className="border border-border-default rounded-lg divide-y divide-border-default">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between px-4 py-3 gap-4">
            <span className="text-sm text-fg-muted">{label}</span>
            <span className="text-sm text-fg-primary font-medium min-w-0 max-w-[60%] text-right [overflow-wrap:anywhere]">
              {value}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
