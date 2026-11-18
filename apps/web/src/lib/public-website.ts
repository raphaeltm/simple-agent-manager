/** The public SAM website (marketing, docs, self-hosting guide). Overridable per deployment. */
export const PUBLIC_WEBSITE_URL =
  import.meta.env.VITE_PUBLIC_WEBSITE_URL || 'https://simple-agent-manager.org';

/** The self-hosting entry point on the public website. */
export const SELF_HOST_URL = `${PUBLIC_WEBSITE_URL.replace(/\/+$/, '')}/self-host/`;
