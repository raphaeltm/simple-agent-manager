import { $, state } from './state.js';

const cleanupStorageKey = 'sam-installer-cleanup';

export function renderCleanup() {
  $('cleanup-panel').hidden = !state.cleanupReceipt;
  const canClean =
    state.cleanupReceipt &&
    state.currentCleanupReceipt !== state.cleanupReceipt.receipt &&
    state.authorizedAccounts.some((account) => account.id === state.cleanupReceipt.accountId);
  $('cleanup-resume').hidden = !canClean;
  $('cleanup-reconnect-form').hidden = !!canClean;
}

export function rememberCleanup(data) {
  if (
    !/^[a-f0-9]{64}$/.test(data?.cleanupReceipt || '') ||
    !/^[a-f0-9]{32}$/.test(data?.cleanupAccountId || '')
  )
    return;
  state.cleanupReceipt = { receipt: data.cleanupReceipt, accountId: data.cleanupAccountId };
  try {
    sessionStorage.setItem(cleanupStorageKey, JSON.stringify(state.cleanupReceipt));
  } catch {
    /* Memory-only when browser storage is unavailable. */
  }
  state.currentCleanupReceipt = data.currentCleanupReceipt || data.cleanupReceipt;
  renderCleanup();
}

export function forgetCleanup() {
  state.cleanupReceipt = undefined;
  try {
    sessionStorage.removeItem(cleanupStorageKey);
  } catch {
    /* Storage can be disabled. */
  }
  renderCleanup();
}

export function restoreSavedCleanup() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(cleanupStorageKey) || 'null');
    if (saved) rememberCleanup({ cleanupReceipt: saved.receipt, cleanupAccountId: saved.accountId });
  } catch {
    /* No valid saved cleanup receipt. No credential is stored here. */
  }
}
