/**
 * Connect step for your own cloud account. Each provider keeps its dedicated
 * form — Hetzner's token test, Google Cloud's "Connect with Google" setup — so
 * the sheet gives every provider its smoothest flow.
 */
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { Skeleton } from '@simple-agent-manager/ui';
import type { ComponentType } from 'react';

import { useCredentials } from '../../hooks/useCredentials';
import { useQueryScope } from '../../hooks/useQueryScope';
import { DigitalOceanCredentialForm } from '../DigitalOceanCredentialForm';
import { GcpCredentialForm } from '../GcpCredentialForm';
import { HetznerTokenForm } from '../HetznerTokenForm';
import { InfomaniakCredentialForm } from '../InfomaniakCredentialForm';
import { ScalewayCredentialForm } from '../ScalewayCredentialForm';
import { UpCloudCredentialForm } from '../UpCloudCredentialForm';
import { VultrCredentialForm } from '../VultrCredentialForm';

type CloudFormComponent = ComponentType<{
  credential?: Parameters<typeof HetznerTokenForm>[0]['credential'];
  onUpdate: () => void;
}>;

const CLOUD_FORMS: Record<CredentialProvider, CloudFormComponent> = {
  hetzner: HetznerTokenForm,
  scaleway: ScalewayCredentialForm,
  gcp: GcpCredentialForm,
  vultr: VultrCredentialForm,
  infomaniak: InfomaniakCredentialForm,
  digitalocean: DigitalOceanCredentialForm,
  upcloud: UpCloudCredentialForm,
};

export function CloudAccountForm({
  providerId,
  onSaved,
}: Readonly<{ providerId: string; onSaved: () => void }>) {
  const queryScope = useQueryScope();
  const { credentials, loading } = useCredentials(queryScope);
  const Form = CLOUD_FORMS[providerId as CredentialProvider];

  if (!Form) {
    return <p className="m-0 text-sm text-fg-muted">This provider can’t be connected here yet.</p>;
  }
  if (loading) {
    return <Skeleton width="100%" height="2.75rem" borderRadius="var(--sam-radius-md)" />;
  }
  return (
    <Form
      credential={credentials.find((credential) => credential.provider === providerId)}
      onUpdate={onSaved}
    />
  );
}
