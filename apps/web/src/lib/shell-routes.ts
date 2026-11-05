/**
 * Routes that lay out their own SAM Glass panes over the void (the project chat, the agent
 * chat and the comment reader). Every other routed page renders inside one content pane that
 * the app shell provides.
 *
 * Shared by `AppShell` (whether to wrap the outlet in a pane) and `Project` (whether to skip
 * the padded page layout), so the two can never disagree about which routes are full-bleed.
 */
export function isFullBleedRoute(pathname: string): boolean {
  return (
    /^\/projects\/[^/]+\/(chat|agent)(\/|$)/.test(pathname) ||
    /^\/projects\/[^/]+\/comments\/[^/]+\/[^/]+\/?$/.test(pathname)
  );
}

/** The project routes that render the project chat: its index (a redirect) and `chat/*`. */
export function isProjectChatRoute(pathname: string): boolean {
  return /\/projects\/[^/]+(?:\/chat(?:\/|$)|\/?$)/.test(pathname);
}
