import { Skeleton } from '@simple-agent-manager/ui';

import { DigitalOceanCredentialForm } from '../components/DigitalOceanCredentialForm';
import { GcpCredentialForm } from '../components/GcpCredentialForm';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { InfomaniakCredentialForm } from '../components/InfomaniakCredentialForm';
import { ScalewayCredentialForm } from '../components/ScalewayCredentialForm';
import { UpCloudCredentialForm } from '../components/UpCloudCredentialForm';
import { VultrCredentialForm } from '../components/VultrCredentialForm';
import { useSettingsContext } from './SettingsContext';

export function SettingsCloudProvider() {
  const { credentials, loading, reload } = useSettingsContext();
  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');
  const scalewayCredential = credentials.find((c) => c.provider === 'scaleway');
  const vultrCredential = credentials.find((c) => c.provider === 'vultr');
  const infomaniakCredential = credentials.find((c) => c.provider === 'infomaniak');
  const digitalOceanCredential = credentials.find((c) => c.provider === 'digitalocean');
  const upcloudCredential = credentials.find((c) => c.provider === 'upcloud');
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
      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">Hetzner</h3>
        <HetznerTokenForm credential={hetznerCredential} onUpdate={reload} />
      </section>

      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">Scaleway</h3>
        <ScalewayCredentialForm credential={scalewayCredential} onUpdate={reload} />
      </section>

      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">Vultr</h3>
        <VultrCredentialForm credential={vultrCredential} onUpdate={reload} />
      </section>

      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">Infomaniak Public Cloud</h3>
        <InfomaniakCredentialForm credential={infomaniakCredential} onUpdate={reload} />
        <h3 className="text-base font-semibold text-fg-primary mb-3">UpCloud</h3>
        <UpCloudCredentialForm credential={upcloudCredential} onUpdate={reload} />
      </section>

      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">DigitalOcean</h3>
        <DigitalOceanCredentialForm credential={digitalOceanCredential} onUpdate={reload} />
      </section>

      <section className="glass-surface rounded-lg p-4">
        <h3 className="text-base font-semibold text-fg-primary mb-3">Google Cloud</h3>
        <GcpCredentialForm credential={gcpCredential} onUpdate={reload} />
      </section>
    </div>
  );
}
