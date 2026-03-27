import { type AnalyticsForwardStatusResponse } from '../../lib/api';

interface ForwardingStatusProps {
  data: AnalyticsForwardStatusResponse | null;
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
        active
          ? 'bg-success-subtle text-success-fg'
          : 'bg-neutral-subtle text-fg-muted'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-success-fg' : 'bg-fg-muted'}`}
      />
      {label}
    </span>
  );
}

export function ForwardingStatus({ data }: ForwardingStatusProps) {
  if (!data) {
    return <p className="text-sm text-fg-muted">Loading...</p>;
  }

  const lastForwarded = data.lastForwardedAt
    ? new Date(data.lastForwardedAt).toLocaleString()
    : 'Never';

  return (
    <div className="flex flex-col gap-3">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          active={data.enabled}
          label={data.enabled ? 'Enabled' : 'Disabled'}
        />
        <StatusBadge
          active={data.destinations.segment.configured}
          label={`Segment: ${data.destinations.segment.configured ? 'Configured' : 'Not configured'}`}
        />
        <StatusBadge
          active={data.destinations.ga4.configured}
          label={`GA4: ${data.destinations.ga4.configured ? 'Configured' : 'Not configured'}`}
        />
      </div>

      {/* Details */}
      <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <span className="text-fg-muted">Last forwarded:</span>{' '}
          <span className="text-fg-primary font-medium">{lastForwarded}</span>
        </div>
        <div>
          <span className="text-fg-muted">Events tracked:</span>{' '}
          <span className="text-fg-primary font-medium">
            {data.events.join(', ')}
          </span>
        </div>
      </div>
    </div>
  );
}
