/**
 * Cloud providers. Source of truth: packages/providers/src (locations, *_VOLUME_CAPABILITIES) and
 * the connect flow in apps/web/src/components/CloudProviderConnectFlow.tsx.
 *
 * Credential precedence is project → user → installation (resolveCredentialSource() in
 * apps/api/src/services/provider-credentials.ts), so an account FAQ must not say a user always needs
 * their own cloud account.
 */
import { faq, feature, type Integration, step } from './types';

const CLOUD_DOCS = '/docs/guides/creating-workspaces/';
const CONNECT_STEP = 'Settings → Infrastructure → Cloud accounts';

const accountFaq = (provider: string) =>
  faq(
    `Do I need my own ${provider} account?`,
    `Only if nobody else provides one. SAM uses a project's cloud account first, then yours, then one the installation administrator connected. With none of those, a profile can still run Instant sessions on Cloudflare Containers.`
  );

const tokenFaq = faq(
  'How is my credential stored?',
  "Encrypted with AES-256-GCM and a unique IV in your installation's database. Machines never receive it: the control plane makes the provider API calls."
);

export const cloudIntegrations: Integration[] = [
  {
    slug: 'hetzner',
    name: 'Hetzner Cloud',
    shortName: 'Hetzner',
    category: 'cloud-providers',
    tagline: 'Low-cost VMs in Germany, Finland and the US',
    description:
      "SAM's first provider. Connect an API token and SAM creates, reuses and deletes Hetzner VMs for workspaces and app deployments, with block volumes for deployment data.",
    logoPath: '/images/integrations/hetzner.svg',
    seoTitle: 'Run AI Coding Agents on Hetzner Cloud | SAM',
    seoDescription:
      'Run AI coding agents on Hetzner Cloud VMs with SAM, the open-source agent platform. SAM provisions, reuses and deletes machines on your Hetzner account.',
    features: [
      feature('Five locations', 'Falkenstein, Nuremberg, Helsinki, Ashburn and Hillsboro.'),
      feature('Token sign-in', 'A Hetzner Cloud API token. No IAM setup.'),
      feature(
        'Persistent volumes',
        'Deployment environments keep their data on Hetzner volumes that survive node replacement.'
      ),
    ],
    howItWorks: [
      step(
        'Create an API token',
        'In the Hetzner Cloud Console, open a project and generate a read-write API token.'
      ),
      step('Connect it', `Paste the token in ${CONNECT_STEP}.`),
      step(
        'Run work',
        'SAM places agents on existing machines with room, or creates a VM in your chosen location.'
      ),
    ],
    useCases: [
      feature('Cheap parallel capacity', 'Run many agent sessions on small, inexpensive machines.'),
      feature('EU data location', 'Keep machines in Germany or Finland.'),
    ],
    faq: [accountFaq('Hetzner'), tokenFaq],
    relatedSlugs: ['scaleway', 'infomaniak', 'claude-code'],
    externalUrl: 'https://www.hetzner.com/cloud',
    externalLabel: 'Hetzner Cloud website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'scaleway',
    name: 'Scaleway',
    category: 'cloud-providers',
    tagline: 'VMs in Paris, Amsterdam and Warsaw',
    description:
      'Connect a Scaleway API key and SAM provisions instances in eight French, Dutch and Polish zones for workspaces and app deployments, with block volumes for deployment data.',
    logoPath: '/images/integrations/scaleway.svg',
    seoTitle: 'Run AI Coding Agents on Scaleway | SAM',
    seoDescription:
      'Run AI coding agents on Scaleway instances with SAM, the open-source agent platform. Eight zones in Paris, Amsterdam and Warsaw.',
    features: [
      feature('Eight zones', 'Paris 1-3, Amsterdam 1-3 and Warsaw 1-2.'),
      feature(
        'Persistent volumes',
        'Deployment environments keep their data on Scaleway block volumes.'
      ),
      feature('API key sign-in', 'A Scaleway secret key and project ID.'),
    ],
    howItWorks: [
      step('Create an API key', 'In the Scaleway Console, open IAM → API keys and create a key.'),
      step('Connect it', `Enter the secret key and project ID in ${CONNECT_STEP}.`),
      step(
        'Run work',
        'SAM creates instances in the zone you choose and reuses them while they have room.'
      ),
    ],
    useCases: [
      feature('EU data location', 'Keep machines in France, the Netherlands or Poland.'),
      feature(
        'Scaleway models via OpenCode',
        "Use OpenCode's custom OpenAI-compatible provider with Scaleway's inference API."
      ),
    ],
    faq: [
      faq(
        'Which zones can I use?',
        'fr-par-1, fr-par-2, fr-par-3, nl-ams-1, nl-ams-2, nl-ams-3, pl-waw-1 and pl-waw-2.'
      ),
      accountFaq('Scaleway'),
      tokenFaq,
    ],
    relatedSlugs: ['hetzner', 'infomaniak', 'opencode'],
    externalUrl: 'https://www.scaleway.com/en/',
    externalLabel: 'Scaleway website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'infomaniak',
    name: 'Infomaniak Public Cloud',
    shortName: 'Infomaniak',
    category: 'cloud-providers',
    tagline: 'Swiss OpenStack cloud in Geneva',
    description:
      'Connect a Keystone application credential and SAM provisions workspace and deployment nodes on Infomaniak Public Cloud in Switzerland, with Cinder volumes that survive node replacement.',
    logoPath: '/images/integrations/infomaniak.svg',
    seoTitle: 'Run AI Coding Agents on Infomaniak Public Cloud | SAM',
    seoDescription:
      'Run AI coding agents and app deployments on Infomaniak Public Cloud in Switzerland with SAM, the open-source agent platform.',
    features: [
      feature('Swiss data location', 'Two regions, dc3-a and dc4-a, both in Geneva.'),
      feature(
        'Standard OpenStack',
        'SAM uses the Keystone, Nova, Glance, Neutron and Cinder APIs.'
      ),
      feature(
        'Persistent volumes',
        'Cinder volumes detach from a replaced node and reattach to the new one in the same region.'
      ),
      feature(
        'Scoped credential',
        'An application credential ID and secret instead of an account password.'
      ),
    ],
    howItWorks: [
      step(
        'Create an application credential',
        "In Infomaniak's OpenStack dashboard, create a Keystone application credential."
      ),
      step('Connect it', `Enter the credential ID and secret in ${CONNECT_STEP}.`),
      step('Run work', 'SAM creates Nova instances and region-matched Cinder volumes.'),
    ],
    useCases: [
      feature('Swiss data residency', 'Keep workspace and deployment machines in Switzerland.'),
      feature(
        'Replacement-safe app data',
        'Keep application state on a volume while deployment nodes are replaced.'
      ),
    ],
    faq: [
      faq(
        'Can SAM resize an attached volume?',
        'SAM detaches the volume, grows it, then reattaches it. Shrinking is not supported.'
      ),
      accountFaq('Infomaniak'),
      tokenFaq,
    ],
    relatedSlugs: ['hetzner', 'scaleway', 'mistral-vibe'],
    externalUrl: 'https://www.infomaniak.com/en/hosting/public-cloud',
    externalLabel: 'Infomaniak Public Cloud website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'vultr',
    name: 'Vultr',
    category: 'cloud-providers',
    tagline: 'Nine locations across Europe, North America, Asia and Australia',
    description:
      'Connect a Vultr API key and SAM provisions Cloud Compute instances for workspaces and app deployments, with NVMe Block Storage for deployment data in the regions that offer it.',
    logoPath: '/images/integrations/vultr.svg',
    seoTitle: 'Run AI Coding Agents on Vultr | SAM',
    seoDescription:
      'Run AI coding agents on Vultr Cloud Compute with SAM, the open-source agent platform. Nine locations across four continents.',
    features: [
      feature(
        'Nine locations',
        'Frankfurt, Amsterdam, London, New Jersey, Chicago, Los Angeles, Tokyo, Singapore and Sydney.'
      ),
      feature(
        'Persistent volumes',
        'NVMe Block Storage, in the subset of Vultr regions that offer it.'
      ),
      feature('API key sign-in', 'A Vultr personal access token.'),
    ],
    howItWorks: [
      step(
        'Create an API key',
        'In the Vultr customer portal, open Account → API and generate a personal access token.'
      ),
      step(
        'Allow all IPs on the token',
        'SAM calls Vultr from Cloudflare Workers, which have no fixed outbound IP, so an IP allowlist on the token blocks provisioning.'
      ),
      step('Connect it', `Paste the key in ${CONNECT_STEP}. Frankfurt is the default region.`),
    ],
    useCases: [
      feature(
        'Machines near your team',
        'Pick a region in North America, Europe, Asia or Australia.'
      ),
      feature(
        'Second provider',
        'Add Vultr next to another provider so a pool can fall back when one runs out of capacity.'
      ),
    ],
    faq: [
      faq(
        'Why must the token allow all IPs?',
        'SAM provisions from Cloudflare Workers, which have no fixed outbound IP. A token restricted to listed IPs rejects those requests.'
      ),
      faq(
        'Roughly what does it cost?',
        "SAM's default Vultr sizes run from about $20 a month (2 vCPU, 4 GB) to $80 a month (6 vCPU, 16 GB), billed hourly by Vultr."
      ),
      accountFaq('Vultr'),
    ],
    relatedSlugs: ['digitalocean', 'hetzner', 'codex'],
    externalUrl: 'https://www.vultr.com/',
    externalLabel: 'Vultr website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'digitalocean',
    name: 'DigitalOcean',
    category: 'cloud-providers',
    tagline: 'Droplets in ten regions across four continents',
    description:
      'Connect a DigitalOcean personal access token and SAM provisions Droplets for workspaces and app deployments, with Block Storage for deployment data.',
    logoPath: '/images/integrations/digitalocean.svg',
    seoTitle: 'Run AI Coding Agents on DigitalOcean | SAM',
    seoDescription:
      'Run AI coding agents on DigitalOcean Droplets with SAM, the open-source agent platform. Ten regions, Block Storage for app deployments.',
    features: [
      feature(
        'Ten regions',
        'Frankfurt, Amsterdam, London, New York (two), San Francisco, Toronto, Singapore, Bangalore and Sydney.'
      ),
      feature(
        'Persistent volumes',
        'Same-region Block Storage for deployment environments, grow-only.'
      ),
      feature(
        'Token sign-in',
        'A full-access personal access token, or custom scopes for the resources SAM manages.'
      ),
    ],
    howItWorks: [
      step('Create a token', 'In the DigitalOcean API settings, generate a personal access token.'),
      step(
        'Connect it',
        `Paste the token in ${CONNECT_STEP}. SAM checks it against the account endpoint.`
      ),
      step('Run work', 'SAM creates Ubuntu 24.04 Droplets, in Frankfurt by default.'),
    ],
    useCases: [
      feature(
        'Second provider',
        'Add DigitalOcean next to another provider for regional choice and fallback capacity.'
      ),
      feature(
        'Persistent app environments',
        'Keep databases, uploads and other state on Block Storage across deployments.'
      ),
    ],
    faq: [
      faq(
        'Which scopes does the token need?',
        'Full access, or custom scopes covering droplets, block storage, tags, account, actions, images, regions and sizes.'
      ),
      accountFaq('DigitalOcean'),
      tokenFaq,
    ],
    relatedSlugs: ['vultr', 'hetzner', 'codex'],
    externalUrl: 'https://www.digitalocean.com/',
    externalLabel: 'DigitalOcean website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'upcloud',
    name: 'UpCloud',
    category: 'cloud-providers',
    tagline: 'Ten locations in Europe, the US, Singapore and Sydney',
    description:
      'Connect a dedicated UpCloud API subaccount and SAM provisions workspace and deployment nodes, with encrypted MaxIOPS volumes for deployment data.',
    logoPath: '/images/integrations/upcloud.svg',
    seoTitle: 'Run AI Coding Agents on UpCloud | SAM',
    seoDescription:
      'Run AI coding agents and app deployments on UpCloud with SAM, the open-source agent platform. Ten locations, encrypted MaxIOPS volumes.',
    features: [
      feature(
        'Ten locations',
        'Frankfurt, Helsinki (two), Amsterdam, London, Chicago, New York, San Jose, Singapore and Sydney.'
      ),
      feature(
        'Persistent volumes',
        'Encrypted volumes that SAM creates, attaches, detaches, grows and keeps until you tear the environment down.'
      ),
      feature(
        'Dedicated subaccount',
        'A separate API subaccount, so SAM never holds your main UpCloud login.'
      ),
    ],
    howItWorks: [
      step('Create an API subaccount', 'In the UpCloud Hub, create a subaccount with API access.'),
      step('Connect it', `Enter its username and password in ${CONNECT_STEP}.`),
      step(
        'Run work',
        'SAM creates servers in the zone you choose for workspaces and deployments.'
      ),
    ],
    useCases: [
      feature('Persistent deployments', 'Run apps whose data must survive node replacement.'),
      feature('Machines near your team', 'Pick a location in Europe, the US or Asia-Pacific.'),
    ],
    faq: [
      faq(
        'Do volumes survive node deletion?',
        'Yes. SAM keeps tracked deployment volumes until you explicitly tear the environment down.'
      ),
      accountFaq('UpCloud'),
      tokenFaq,
    ],
    relatedSlugs: ['hetzner', 'digitalocean', 'vultr'],
    externalUrl: 'https://upcloud.com',
    externalLabel: 'UpCloud website',
    docsPath: CLOUD_DOCS,
  },
  {
    slug: 'gcp',
    name: 'Google Cloud',
    shortName: 'GCP',
    category: 'cloud-providers',
    tagline: 'Compute Engine with keyless sign-in',
    description:
      'Sign in with Google and SAM sets up Workload Identity Federation in your project for you, or connect a service-account key. SAM then provisions Compute Engine VMs.',
    logoPath: '/images/integrations/gcp.svg',
    seoTitle: 'Run AI Coding Agents on Google Cloud | SAM',
    seoDescription:
      'Run AI coding agents on Google Compute Engine with SAM, the open-source agent platform. Keyless Workload Identity Federation, set up for you.',
    features: [
      feature(
        'Keyless by default',
        'Connect with Google and SAM enables the APIs it needs, creates the WIF pool, provider and service account, and grants the bindings in your project.'
      ),
      feature(
        'Service-account key option',
        'Where the installation has no Google infrastructure OAuth client, connect a service-account JSON key instead.'
      ),
      feature(
        'Live machine catalog',
        "SAM builds its list of machine types and prices from Google's own catalog and billing data."
      ),
      feature(
        'Eight zones',
        'Iowa, South Carolina, Oregon, Belgium, Frankfurt, London, Singapore and Tokyo.'
      ),
    ],
    howItWorks: [
      step(
        'Connect with Google',
        `In ${CONNECT_STEP}, sign in with a Google account that can administer your VM project.`
      ),
      step(
        'Pick the project and zone',
        'SAM sets up Workload Identity Federation in that project and verifies the token exchange.'
      ),
      step(
        'Run work',
        'SAM creates Compute Engine VMs with short-lived credentials. The VMs get no service account.'
      ),
    ],
    useCases: [
      feature(
        'Use existing Google commitments',
        'Run agent machines on a GCP project that already has credits or a billing agreement.'
      ),
      feature(
        'No stored long-lived key',
        'With WIF, SAM exchanges short-lived tokens instead of keeping a service-account key.'
      ),
    ],
    faq: [
      faq(
        'Does GCP support persistent deployment volumes?',
        'Not yet. A deployment environment on Google Cloud cannot use persistent volumes, so put environments that need them on another provider.'
      ),
      faq(
        'What does the installation administrator need to set up?',
        'A Google OAuth client for infrastructure sign-in, with the Cloud Resource Manager and IAM APIs enabled. The Google Cloud guide lists every step.'
      ),
      accountFaq('Google Cloud'),
    ],
    relatedSlugs: ['gemini-cli', 'google-antigravity', 'hetzner'],
    externalUrl: 'https://cloud.google.com/compute',
    externalLabel: 'Compute Engine website',
    docsPath: '/docs/guides/google-cloud/',
  },
];
