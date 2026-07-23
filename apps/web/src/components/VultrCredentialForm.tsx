import type { CredentialResponse } from '@simple-agent-manager/shared';

import { SingleTokenCredentialForm } from './SingleTokenCredentialForm';

interface VultrCredentialFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/** Form for adding/updating/deleting a Vultr API key (single-token provider). */
export function VultrCredentialForm({ credential, onUpdate }: VultrCredentialFormProps) {
  return (
    <SingleTokenCredentialForm
      provider="vultr"
      credential={credential}
      onUpdate={onUpdate}
      title="Vultr"
      noun="API key"
      tokenLabel="Vultr API Key"
      tokenId="vultr-token"
      placeholder="Enter your Vultr Personal Access Token"
      help={
        <>
          Get your API key from{' '}
          <a
            href="https://my.vultr.com/settings/#settingsapi"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            Vultr Account &gt; API
          </a>
          . Set Access Control to <strong>Allow All IPv4/IPv6</strong> — SAM calls Vultr from
          Cloudflare with no fixed IP, so a restricted allowlist will block provisioning.
        </>
      }
    />
  );
}
