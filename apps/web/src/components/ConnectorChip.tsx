/** Visible provenance for work started by a user through an external AI app. */
export function ConnectorChip({ clientName }: { clientName?: string | null }) {
  return (
    <span
      className="inline-block max-w-[40%] shrink-0 truncate rounded bg-accent-tint px-1.5 py-0.5 text-xs text-fg-secondary"
      title={`Created via ${clientName || 'Connector'}`}
    >
      via {clientName || 'Connector'}
    </span>
  );
}
