/**
 * Teardown's advice on SAM's shared firewall rules (teardown-gcp.ts `firewallUsage`): which VMs a
 * rule applies to, by network and target tag, as GCP applies it. Read-only advice; teardown never
 * deletes these rules. Box round R15 (G5): labelled fixture VMs without the tag were reported as
 * users. The CLI path is in teardown.test.ts; these cover the branches it does not reach.
 */
import { describe, expect, it } from 'vitest';

import { firewallUsage, parseFirewallTargets } from './teardown-gcp';

type Instance = Exclude<Parameters<typeof firewallUsage>[1], Error>[number];
const OWN_INSTALL = 'a'.repeat(32);

function vmOn(
  name: string,
  network: string,
  tags: string[],
  labels: Record<string, string> = {}
): Instance {
  return { id: name, name, zone: 'europe-west1-b', labels, disks: [], tags, networks: [network] };
}

const samLabels = (installation: string) => ({
  managed: 'simple-agent-manager',
  installation,
  env: 'selfhost',
  node: 'n',
});
const agentRule = parseFirewallTargets(
  JSON.stringify({
    network: 'https://www.googleapis.com/compute/v1/projects/p/global/networks/default',
    targetTags: ['sam-agent'],
  })
);

describe('firewallUsage', () => {
  it('a VM with the tag on another network does not use the rule', () => {
    const other = vmOn('elsewhere', 'sam-selfhost', ['sam-agent']);
    expect(firewallUsage(agentRule, [other], [], OWN_INSTALL)).toBe(
      'no existing VM in this project uses it (tag sam-agent; a VM made later may)'
    );
    // Control: the same VM on the rule's network does.
    const same = vmOn('here', 'default', ['sam-agent']);
    expect(firewallUsage(agentRule, [same], [], OWN_INSTALL)).toBe(
      '1 other VM(s) in this project use it (tag sam-agent: here), so keep it'
    );
  });

  it("leaves out this install's own node VMs (teardown removes them)", () => {
    const own = vmOn('mine', 'default', ['sam-agent'], samLabels(OWN_INSTALL));
    expect(firewallUsage(agentRule, [own], [own], OWN_INSTALL)).toMatch(/^no existing VM/);
    // Control: another install's labelled VM with the tag counts.
    const theirs = vmOn('theirs', 'default', ['sam-agent'], samLabels('b'.repeat(32)));
    expect(firewallUsage(agentRule, [own, theirs], [own, theirs], OWN_INSTALL)).toMatch(
      /^1 other VM\(s\) .*theirs/
    );
  });

  it('a rule without target tags applies to every VM on its network', () => {
    const rule = parseFirewallTargets(JSON.stringify({ network: 'x/networks/default' }));
    const untagged = vmOn('plain', 'default', []);
    expect(firewallUsage(rule, [untagged], [], OWN_INSTALL)).toBe(
      '1 other VM(s) in this project use it (every VM on network default: plain), so keep it'
    );
  });

  it.each([
    ['targets service accounts', JSON.stringify({ targetServiceAccounts: ['sa@x'] })],
    ['is not JSON', 'not json'],
    ['is a list', '[]'],
  ])('says it cannot tell when the rule %s', (_case, json) => {
    expect(firewallUsage(parseFirewallTargets(json), [], [], OWN_INSTALL)).toBe(
      'teardown could not read which VMs it applies to; check them before deleting it'
    );
  });

  it("says it cannot tell when the project's VMs cannot be listed", () => {
    expect(firewallUsage(agentRule, new Error('PERMISSION_DENIED'), [], OWN_INSTALL)).toBe(
      "teardown could not list the project's VMs to see which use it (PERMISSION_DENIED)"
    );
  });
});
