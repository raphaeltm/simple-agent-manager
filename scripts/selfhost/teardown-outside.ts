/**
 * Teardown items outside SAM (teardown.ts): what the operator made by following the setup steps,
 * which teardown cannot reach. Each is printed with the place to click or the command to run and
 * listed as "left for you" in the summary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeardownContext } from './teardown-box';
import { both, type Item, STEPS } from './teardown-model';

export function outsideItems(ctx: TeardownContext): Item[] {
  const domain = ctx.domain || '<your SAM domain>';
  const keep = { act: 'keep' as const, why: 'needed to bring the install back' };
  const operator = (why: string) => ({
    'keep-data': keep,
    'remove-everything': { act: 'operator' as const, why },
  });
  const items: Item[] = [
    {
      id: 'outside:github-app',
      place: 'outside SAM',
      what: 'the GitHub App created through Admin → Integrations (manifest flow), if you made one',
      provenance: 'from the setup steps',
      how: `github.com → Settings → Developer settings → GitHub Apps (for an organization: its Settings → Developer settings → GitHub Apps) → the App whose URL is https://app.${domain} → Advanced → Delete GitHub App. Its installations go with it`,
      step: STEPS.outside,
      plan: operator('GitHub deletes Apps only in its own settings'),
    },
    {
      id: 'outside:dns',
      place: 'outside SAM',
      what: `DNS: the wildcard record *.${domain} you pointed at the box`,
      provenance: 'from the setup steps',
      how: `remove it at your DNS host (Google Cloud DNS: gcloud dns record-sets delete '*.${domain}.' --type=A --zone=<zone>)`,
      step: STEPS.outside,
      plan: operator('teardown has no access to your DNS host'),
    },
    {
      id: 'outside:box',
      place: 'outside SAM',
      what: 'the machine itself, and on a cloud its service account and the bucket grant you gave it',
      provenance: 'from the setup steps',
      how: 'delete them in your cloud console (Google Cloud: gcloud compute instances delete <box> --zone <zone>; gcloud iam service-accounts delete <box account>), and this checkout with rm -r',
      step: STEPS.outside,
      plan: operator('you created them; teardown runs on the box'),
    },
    {
      id: 'outside:accounts',
      place: 'outside SAM',
      what: 'OAuth clients and SMTP relay credentials you registered for this install',
      provenance: 'from the setup steps',
      how: 'delete or revoke them in each service (GitHub OAuth Apps, Google Cloud OAuth clients, your SMTP provider)',
      step: STEPS.outside,
      plan: operator('teardown has no access to those services'),
    },
    {
      id: 'outside:other-clouds',
      place: 'in your cloud, made by SAM at runtime',
      what: 'node VMs on any provider other than Google Cloud (Hetzner, Scaleway, AWS, ...)',
      provenance: 'from the setup steps',
      how: `before teardown, delete every node in Admin → Nodes while SAM runs; or in the provider's console delete servers labelled managed=simple-agent-manager and installation=${ctx.installationId ?? '<installation id>'}`,
      step: STEPS.compute,
      plan: both({ act: 'operator', why: 'only the Google Cloud adapter exists so far' }),
    },
  ];
  const profiles = (ctx.box.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim());
  if (profiles.includes('mail-in')) {
    items.push({
      id: 'outside:mail',
      place: 'outside SAM',
      what: `inbound mail: the MX record agents.${domain} and the port 25 firewall rule you opened`,
      provenance: 'from the setup steps',
      how: `remove the MX record at your DNS host; Google Cloud: gcloud compute firewall-rules delete sam-smtp-in --project <project>`,
      step: STEPS.outside,
      plan: operator('you created them by hand (README, Inbound agent email)'),
    });
  }
  const provider = keyProvider(ctx.stateDir);
  if (provider === 'aws-kms' || provider === 'azure-kv') {
    items.push({
      id: `outside:${provider}`,
      place: 'outside SAM',
      what: `the ${provider === 'aws-kms' ? 'AWS KMS' : 'Azure Key Vault'} key that seals this box`,
      provenance: 'from the setup steps',
      how: 'README, Removing what setup created: the AWS or Azure commands',
      step: STEPS.outside,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the key' },
        'remove-everything': ctx.options.destroyKey
          ? { act: 'operator', why: 'you created it; no bootstrap for this cloud yet' }
          : { act: 'keep', why: 'pass --destroy-key to be told how to delete it' },
      },
      forGood: 'every sealed bundle and every backup sealed with it becomes unrecoverable',
    });
  }
  return items;
}

function keyProvider(stateDir: string): string | null {
  try {
    const choice = JSON.parse(
      readFileSync(join(stateDir, 'key-agent', 'choice.json'), 'utf8')
    ) as unknown;
    const provider = (choice as { provider?: unknown }).provider;
    return typeof provider === 'string' ? provider : null;
  } catch {
    return null;
  }
}
