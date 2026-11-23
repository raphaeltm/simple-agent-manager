import { fileURLToPath } from 'node:url';

import { ApiFailure, createApi, readTarget, wrangler } from './installer-target.mjs';

// Removes an installer from the account. Installations it made are separate: their
// sam-maintenance-… services and everything they created are never touched here.
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const { token, name, base, worker } = readTarget();
const api = createApi({ token, base, registrationToken: process.env.OAUTH_REGISTRATION_TOKEN });

let settings;
try {
  settings = await api(`${worker}/settings`);
} catch (error) {
  if (!(error instanceof ApiFailure) || error.status !== 404) throw error;
}
const origin = (Array.isArray(settings?.bindings) ? settings.bindings : []).find(
  (binding) => binding.name === 'APP_ORIGIN' && binding.type === 'plain_text'
)?.text;

// The installer's OAuth client is deleted only on request. Whether Cloudflare keeps the
// account tokens an installation received through that client's sign-in once the client
// is gone is unverified (SAM idea 01M84YHD4FZP1C6PXK6AQZMEMM), so the default leaves it:
// without the installer Worker, which held its only secret, the client cannot be used.
const removeClient = process.env.REMOVE_OAUTH_CLIENT === 'true';
let clients = [];
if (removeClient) {
  const listed = await api(`${base}/oauth_clients`);
  if (!Array.isArray(listed)) throw new Error('Invalid OAuth client list');
  clients = listed.filter(
    (candidate) => candidate.client_name === name && (!origin || candidate.client_uri === origin)
  );
  if (!origin && clients.length > 1)
    throw new Error(
      `Several OAuth clients are named ${name}. Delete the one you mean under Manage Account → OAuth clients.`
    );
}

if (settings) {
  wrangler(['delete', '--name', name, '--force']);
  console.log(`Removed the installer Worker ${name}.`);
} else console.log(`No installer Worker named ${name} in this account.`);

if (removeClient) {
  for (const client of clients)
    await api(`${base}/oauth_clients/${encodeURIComponent(client.client_id)}`, 'DELETE');
  console.log(
    clients.length
      ? `Removed the OAuth client ${name}.`
      : `No OAuth client named ${name} for this installer.`
  );
} else
  console.log(
    `Kept the OAuth client ${name}; it cannot be used without the installer. To delete it too, run again with REMOVE_OAUTH_CLIENT=true or delete it under Manage Account → OAuth clients.`
  );
console.log('Installations made with this installer were not changed.');
