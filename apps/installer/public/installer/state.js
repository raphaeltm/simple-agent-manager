// Shared mutable state and DOM lookup for the installer SPA. Kept tiny and
// dependency-free so every other module can import it without cycles.
export const $ = (id) => document.getElementById(id);

export const state = {
  busy: false,
  fullInstaller: false,
  approvedPlan: undefined,
  formRevision: 0,
  zoneLoad: 0,
  cleanupReceipt: undefined,
  currentCleanupReceipt: undefined,
  authorizedAccounts: [],
};
