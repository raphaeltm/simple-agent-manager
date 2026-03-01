import { Skeleton } from '@simple-agent-manager/ui';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { useSettingsContext } from './SettingsContext';

export function SettingsCloudProvider() {
  const { credentials, loading, reload } = useSettingsContext();
  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');

  if (loading && credentials.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton width="30%" height="0.875rem" />
        <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
        <Skeleton width="80px" height="2.25rem" borderRadius="var(--sam-radius-md)" />
      </div>
    );
  }

  return <HetznerTokenForm credential={hetznerCredential} onUpdate={reload} />;
}
