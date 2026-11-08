import { forgetCleanup, rememberCleanup } from './cleanup.js';
import { invalidatePlan } from './plan-state.js';
import { returnToConnect } from './screens.js';

export async function api(path, body) {
  const response = await fetch(
    `/api/session/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}
  );
  const data = await response.json();
  if (response.status === 401) {
    forgetCleanup();
    invalidatePlan();
    returnToConnect('Your session expired after 15 minutes. Sign in again to continue.');
    throw new Error('session-expired');
  }
  rememberCleanup(data);
  if (!response.ok) throw new Error(data.error || 'The request failed. Please retry.');
  return data;
}
