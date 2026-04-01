import { Skeleton } from '@simple-agent-manager/ui';

import { GcpCredentialForm } from '../components/GcpCredentialForm';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { ScalewayCredentialForm } from '../components/ScalewayCredentialForm';
import { useSettingsContext } from './SettingsContext';

export function SettingsCloudProvider() {
  const { credentials, loading, reload } = useSettingsContext();
  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');
  const scalewayCredential = credentials.find((c) => c.provider === 'scaleway');
  const gcpCredential = credentials.find((c) => c.provider === 'gcp');

  if (loading && credentials.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-2">
        <Skeleton width="30%" height="0.875rem" />
        <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
        <Skeleton width="80px" height="2.25rem" borderRadius="var(--sam-radius-md)" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h3 className="text-base font-semibold text-fg-primary mb-3">Hetzner</h3>
        <HetznerTokenForm credential={hetznerCredential} onUpdate={reload} />
      </section>

      <section>
        <h3 className="text-base font-semibold text-fg-primary mb-3">Scaleway</h3>
        <ScalewayCredentialForm credential={scalewayCredential} onUpdate={reload} />
      </section>

      <section>
        <h3 className="text-base font-semibold text-fg-primary mb-3">Google Cloud</h3>
        <GcpCredentialForm credential={gcpCredential} onUpdate={reload} />
      </section>
    </div>
  );
}
