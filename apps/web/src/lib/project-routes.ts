/**
 * In-app paths to a project's resources.
 *
 * One builder per destination, so a route change is one edit rather than a grep. Every segment
 * is encoded: an id reaches the client from the server, and an unencoded one could contribute
 * path segments of its own.
 *
 * `projectChatPath` started life in `automation-routes.ts`, which is still where Automation's
 * own URLs live; it moved here once the chat, library and ideas links were needed outside
 * Automation too, and `automation-routes.ts` re-exports it so its existing importers are
 * unaffected.
 */
const projectRoot = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

/** A chat in the project: the chats automations start, and the chats linked work points at. */
export const projectChatPath = (projectId: string, sessionId: string) =>
  `${projectRoot(projectId)}/chat/${encodeURIComponent(sessionId)}`;

/** One idea's page. */
export const projectIdeaPath = (projectId: string, ideaId: string) =>
  `${projectRoot(projectId)}/ideas/${encodeURIComponent(ideaId)}`;

/**
 * The project library, opened on one file's preview.
 *
 * The library page reads `?preview=<fileId>` and opens the modal for it, fetching the file
 * directly when it is not on the current page of results (`pages/ProjectLibrary.tsx`).
 */
export const projectLibraryFilePath = (projectId: string, fileId: string) =>
  `${projectRoot(projectId)}/library?preview=${encodeURIComponent(fileId)}`;
