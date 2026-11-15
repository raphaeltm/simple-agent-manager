/** PROTOTYPE ONLY — the stress set for /prototype/inbox: ~40 items across 4 projects. */
import { BASE_ITEMS, type InboxItem, type Kind, must } from './mock-data';

const PROJECTS = ['SAM', 'Acme Billing', 'Kiln website', 'Field Notes'];
const CHATS = [
  'Migrate every remaining hand-rolled loader in the settings area to TanStack Query and prove nothing unmounts on refetch',
  'Ship billing',
  'Launch week checklist',
  'Nightly backups',
  'GCP capacity pool catalog publication deadline loop',
  'Weekend photos post',
  'Docs refresh',
  'Fix orphan sweep on GCP',
];
const LONG =
  'Decide whether the agent should rewrite the whole onboarding flow for self-hosters who already configured a GitHub App with the old GH_* secret names, or keep a compatibility shim for one more release and file a follow-up';

export const TWELVE_STEP_TASK: InboxItem = {
  ...must(BASE_ITEMS[5]),
  id: 'stress-12-steps',
  title: 'Move the production DNS zone to the new Cloudflare account without downtime',
  why: 'Needs both accounts’ owner logins and a registrar change. I prepared every record and a rollback.',
  steps: [
    'Export the zone file from the old account',
    'Import it into the new account and compare record counts (expect 214)',
    'Lower TTLs on the old zone to 60 seconds',
    'Wait one hour for old TTLs to expire',
    'Create the Origin CA certificate in the new account',
    'Copy the Worker routes for api.*, app.* and ws-*',
    'Re-create the Tail Worker binding',
    'Change nameservers at the registrar',
    'Watch the health check page for 15 minutes',
    'Run the staging smoke test against production DNS',
    'Raise TTLs back to auto',
    'Delete the zone from the old account after 7 days',
  ].map((text, i) => ({ text, done: i < 3 })),
};

export const TEN_OPTION_QUESTION: InboxItem = {
  ...must(BASE_ITEMS[1]),
  id: 'stress-10-options',
  title: 'Which region should new staging nodes default to?',
  why: 'Placement falls back to this when a pool has no preference. Prices differ by up to 30%.',
  options: [
    'Falkenstein (fsn1)',
    'Nuremberg (nbg1)',
    'Helsinki (hel1)',
    'Ashburn (ash)',
    'Hillsboro (hil)',
    'Singapore (sin)',
    'Paris (Scaleway par1)',
    'Amsterdam (Scaleway ams1)',
    'Frankfurt (GCP europe-west3) — the most expensive, but it is where the database lives',
    'Let the scheduler pick the cheapest',
  ],
};

const KINDS: Kind[] = [
  'question',
  'review',
  'task',
  'secret',
  'question',
  'review',
  'permission',
  'question',
  'approval',
  'question',
];

function makeItem(i: number): InboxItem {
  const kind = must(KINDS[i % KINDS.length]);
  const template = must(
    BASE_ITEMS.find((it) => it.kind === kind),
    kind
  );
  const project = must(PROJECTS[i % PROJECTS.length]);
  const chat = must(CHATS[i % CHATS.length]);
  const title =
    i % 7 === 0
      ? `${LONG} (${i})`
      : i % 5 === 0
        ? `Approve https://kiln-preview-${i}.example.dev/very/long/path/that/does/not/break/naturally/at/all`
        : `${template.title} — ${project} #${i}`;
  return {
    ...template,
    id: `stress-${i}`,
    title,
    project,
    chat,
    ageMin: 5 + i * 37,
    groupKey: i % 9 === 1 ? 'stress-group' : undefined,
    deadlineMin: kind === 'permission' ? 2 + i : undefined,
  };
}

export const STRESS_ITEMS: InboxItem[] = [
  TEN_OPTION_QUESTION,
  TWELVE_STEP_TASK,
  ...Array.from({ length: 38 }, (_, i) => makeItem(i + 1)),
];

const ACME_CHATS = [
  'Ship billing',
  'Invoice PDF export',
  'Migrate every remaining hand-rolled invoice loader to the new ledger API and prove nothing double-counts refunds across currency conversions',
  'Dunning emails for failed renewals',
  'Clean up staging',
  'Backfill tax IDs for 2,400 EU customers',
  'Chargeback webhook retries',
  'Customer portal: download all invoices as a zip',
];

/** Long enough to wrap three lines on a phone; it is the most urgent row in the busy set. */
const LONG_PERMISSION_TITLE =
  'Allow pnpm db:migrate --env staging to apply 0031_invoice_pdf_url.sql, 0032_tax_id_backfill.sql and 0033_dunning_schedule.sql in one run against the shared staging database';

/** The busy project for the Overview: the same 40 asks, all in Acme Billing. */
export const BUSY_ITEMS: InboxItem[] = STRESS_ITEMS.map((item, i) => {
  const id = item.id.replace('stress', 'busy');
  return {
    ...item,
    id,
    title:
      id === 'busy-6'
        ? LONG_PERMISSION_TITLE
        : item.title.replace(/ — (SAM|Kiln website|Field Notes|Acme Billing) #/, ' #'),
    project: 'Acme Billing',
    chat: must(ACME_CHATS[i % ACME_CHATS.length]),
  };
});
