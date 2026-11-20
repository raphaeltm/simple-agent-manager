/**
 * teardown-gcp.ts copies two firewall rule names from the GCP provider instead of importing them
 * (the provider module needs @simple-agent-manager/shared built). Pin the copies to the provider's
 * declarations so a rename there cannot silently hide the rules from the teardown inventory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SAM_AGENT_FIREWALL_RULE_NAME, SAM_APP_ROUTE_FIREWALL_RULE_NAME } from './teardown-gcp';

const PROVIDER = readFileSync(
  resolve(import.meta.dirname, '../../packages/providers/src/gcp-metadata.ts'),
  'utf8'
);

describe('teardown-gcp firewall rule names', () => {
  it.each([
    ['SAM_AGENT_FIREWALL_RULE_NAME', SAM_AGENT_FIREWALL_RULE_NAME],
    ['SAM_APP_ROUTE_FIREWALL_RULE_NAME', SAM_APP_ROUTE_FIREWALL_RULE_NAME],
  ])('%s equals the provider declaration', (name, value) => {
    expect(PROVIDER).toContain(`export const ${name} = '${value}';`);
  });
});
