/**
 * Trial ChatGate — placeholder owned by Track D.
 *
 * Track C (frontend discovery) mounts this below the event feed so
 * TryDiscovery compiles before Track D lands. Track D will replace this stub
 * with the real login-gated chat entry point (suggested-action chips + login
 * sheet) per idea §2.3–§2.4.
 *
 * Intentionally renders nothing so layout tests only see what Track C owns.
 */
export interface ChatGateProps {
  /** Trial identifier (matches `/try/:trialId`). */
  trialId: string;
  /** Project id returned by `/api/trial/create` (used when the gate invites login). */
  projectId?: string | null;
  /** True once `trial.ready` has fired — Track D should show the primary CTA. */
  ready: boolean;
  /** Suggested follow-up ideas surfaced during discovery; become chips in Track D. */
  ideas: Array<{ ideaId: string; title: string; summary: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ChatGate(_props: ChatGateProps): null {
  return null;
}
