import { Card, Body } from '@simple-agent-manager/ui';

export function AdminStream() {
  return (
    <Card>
      <div style={{ padding: 'var(--sam-space-6)', textAlign: 'center' }}>
        <Body style={{ color: 'var(--sam-color-fg-muted)' }}>
          Real-time log stream coming soon.
        </Body>
      </div>
    </Card>
  );
}
