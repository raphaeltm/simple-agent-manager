import type { CredentialResponse } from '@simple-agent-manager/shared';

import { SingleTokenCredentialForm } from './SingleTokenCredentialForm';

interface DigitalOceanCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/** Form for adding/updating/deleting a DigitalOcean API key (single-token provider). */
export function DigitalOceanCredentialForm({ credential, onUpdate }: DigitalOceanCredentialFormProps) {
  return (
    <SingleTokenCredentialForm
      provider="digitalocean"
      credential={credential}
      onUpdate={onUpdate}
      title="DigitalOcean"
      noun="API key"
      tokenLabel="DigitalOcean API Key"
      tokenId="digitalocean-token"
      placeholder="Enter your DigitalOcean Personal Access Token"
      help={
        <>
          Get your API key from{' '}
          <a
            href="https://cloud.digitalocean.com/account/api/tokens"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            DigitalOcean API &gt; Tokens
          </a>
          . Generate a token with <strong>Full Access</strong> (or custom scopes covering droplet,
          block_storage, tag, image, region, size, account, and actions).
        </>
      }
    />
  );
}
