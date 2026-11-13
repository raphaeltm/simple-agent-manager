/**
 * Enterprise deep-dive pages, in reading order. Used by /enterprise/ and by each subpage's
 * previous/next navigation. Claims on these pages are checked against the code; see the
 * task record tasks/archive/2026-11-13-integrations-enterprise-pages-rewrite.md.
 */
export interface EnterprisePage {
  slug: string;
  label: string;
  summary: string;
}

export const enterprisePages: EnterprisePage[] = [
  { slug: 'security', label: 'Isolation and network', summary: 'The VM is the boundary. One user per machine, ingress firewall, short-lived per-node keys.' },
  { slug: 'compliance', label: 'Data and credentials', summary: 'What is stored where, how secrets are encrypted, and which cloud account pays for machines.' },
  { slug: 'governance', label: 'Access and oversight', summary: 'Sign-in, roles, project membership, profiles, policies and what admins can see.' },
  { slug: 'cost-control', label: 'Cost controls', summary: 'Direct cloud billing, per-user AI budgets, vCPU-hour quotas and the admin cost page.' },
  { slug: 'scale', label: 'Scale and scheduling', summary: 'Capacity pools, reservation-based placement, warm reuse and automatic cleanup.' },
  { slug: 'agent-agnostic', label: 'Agent choice', summary: 'Seven agents, several accounts per user, and profiles that pick the agent per task.' },
  { slug: 'open-source', label: 'Open source', summary: 'AGPL-3.0, every component in one public repository, and commercial licensing if you need it.' },
];

export const SUPPORT_EMAIL = 'support@simple-agent-manager.org';
