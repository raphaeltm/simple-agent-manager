import { api } from './api.js';
import { invalidatePlan } from './plan-state.js';
import { message, progress, screen, stepIndex } from './screens.js';
import { $, state } from './state.js';

export { invalidatePlan };

export async function loadZones() {
  invalidatePlan();
  const request = ++state.zoneLoad;
  const accountId = $('account-id').value;
  const { zones } = await api('zones', { accountId });
  if (request !== state.zoneLoad || accountId !== $('account-id').value) return;
  $('zone-id').replaceChildren(
    ...zones.map((zone) => {
      const option = document.createElement('option');
      option.value = zone.id;
      option.textContent = zone.name;
      return option;
    })
  );
  // Default to the zone apex: Cloudflare's free certificate covers it and one
  // label below, which is every hostname SAM serves to a browser.
  $('base-domain').value = zones[0] ? zones[0].name : '';
  $('base-domain-shown').textContent = $('base-domain').value;
}

function conflictText(plan) {
  const kind = (record) =>
    record.type === 'certificate' ? 'certificate' : record.type === 'route' ? 'route' : 'dns';
  const names = (group) =>
    plan.conflicts
      .filter((record) => kind(record) === group)
      .map((record) => record.name)
      .join(', ');
  const parts = [];
  if (names('dns')) parts.push(`Existing DNS records block installation: ${names('dns')}.`);
  if (names('route')) parts.push(`Existing Workers routes block installation: ${names('route')}.`);
  if (names('certificate'))
    parts.push(`No active Cloudflare certificate covers ${names('certificate')}.`);
  return parts.join(' ');
}

function appendDetailRow(list, label, value) {
  const group = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  if (typeof value === 'string') detail.textContent = value;
  else detail.append(value);
  group.append(term, detail);
  list.append(group);
}

function renderCreatedDetails(plan) {
  const list = document.createElement('dl');
  list.className = 'plan-list';
  const hosts = document.createElement('ul');
  plan.hostnames.forEach((host) => {
    const li = document.createElement('li');
    li.textContent = host;
    hosts.append(li);
  });
  appendDetailRow(list, 'Hostnames', hosts);
  appendDetailRow(
    list,
    'workers.dev address',
    `${plan.workersDev.subdomain}.workers.dev (${plan.workersDev.action === 'create' ? 'new' : 'already set up'})`
  );
  const source = document.createElement('a');
  source.textContent = plan.sourceCommit;
  if (/^[a-f0-9]{40}$/.test(plan.sourceCommit))
    source.href = `https://github.com/raphaeltm/simple-agent-manager/commit/${plan.sourceCommit}`;
  appendDetailRow(list, 'Source commit', source);
  return list;
}

export function renderPlanSummary(plan, context) {
  const line = $('plan-summary-line');
  const details = $('plan-summary');
  const blocked = $('review-blocked');
  const form = $('review-form');
  if (plan.conflicts.length) {
    line.textContent = '';
    blocked.hidden = false;
    form.hidden = true;
    // The conflict reason is the headline here; "What will be created" stays
    // collapsed since there is nothing to create until it is resolved.
    $('plan-details').hidden = true;
    message(conflictText(plan), 'warning');
    return;
  }
  $('plan-details').hidden = false;
  line.dataset.tone = '';
  // The app hostname is the server's own plan output, not a client-side
  // reconstruction from the raw domain input (which may differ after the
  // server's own normalization).
  const appHost =
    plan.hostnames.find((host) => host.startsWith('app.')) ?? `app.${context.baseDomain}`;
  line.textContent = `SAM will live at ${appHost}${context.accountName ? ` in ${context.accountName}` : ''}. Cloudflare usage charges apply.`;
  details.replaceChildren(renderCreatedDetails(plan));
  state.approvedPlan = plan;
  blocked.hidden = true;
  form.hidden = false;
  // A freshly reviewed plan always starts unconfirmed, even if a previous
  // plan on this screen had already been ticked.
  $('confirm-full').checked = false;
  $('install').disabled = true;
}

export async function runPreview() {
  if (state.busy) return;
  state.busy = true;
  invalidatePlan();
  message('');
  const revision = state.formRevision;
  const previousLabel = $('preview').textContent;
  $('preview').disabled = true;
  $('preview').textContent = 'Checking your installation…';
  const baseDomain = $('base-domain').value.trim().toLowerCase();
  const accountName = $('account-id').selectedOptions[0]?.textContent;
  try {
    const { plan } = await api('preview', {
      accountId: $('account-id').value,
      zoneId: $('zone-id').value,
      zoneName: $('zone-id').selectedOptions[0]?.textContent,
      baseDomain,
      ownerEmail: $('owner-email').value.trim(),
    });
    if (revision !== state.formRevision) return;
    renderPlanSummary(plan, { baseDomain, accountName });
    screen('review');
    progress(stepIndex('review'));
  } catch (error) {
    if (error.message !== 'session-expired') message(error.message, 'error');
  } finally {
    state.busy = false;
    $('preview').disabled = false;
    $('preview').textContent = previousLabel;
  }
}
