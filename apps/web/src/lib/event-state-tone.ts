export function stateTone(state: string): string {
  switch (state) {
    case 'active':
    case 'delivered':
    case 'acked':
    case 'accepted':
    case 'matched':
    case 'batch_created':
    case 'record_only':
      return 'bg-success-tint text-success-fg';
    case 'pending':
    case 'queued_for_prompt_delivery':
    case 'runtime_steer':
    case 'runtime_interrupt':
    case 'spawn_task':
      return 'bg-info-tint text-info-fg';
    case 'retry':
    case 'ambiguous':
      return 'bg-warning-tint text-warning-fg';
    case 'failed':
    case 'unauthorized':
    case 'unsupported':
    case 'critical':
    case 'error':
      return 'bg-danger-tint text-danger-fg';
    case 'cancelled':
    case 'expired':
    case 'recorded_not_injected':
    default:
      return 'bg-surface-secondary text-fg-muted';
  }
}
