/** Internal headers set by the authenticated Worker route before the ProjectData upgrade. */
export const BROWSER_SOCKET_ACTOR_ID_HEADER = 'x-sam-browser-socket-actor-id';
export const BROWSER_SOCKET_EXPIRES_AT_HEADER = 'x-sam-browser-socket-expires-at';

/** Application close code for expired, revoked, malformed or unverifiable socket authority. */
export const BROWSER_SOCKET_UNAUTHORIZED_CLOSE_CODE = 4403;

/** Browser sockets subscribe to project data but never carry a write capability. */
export const BROWSER_SOCKET_READ_CAPABILITY = 'project:read';
