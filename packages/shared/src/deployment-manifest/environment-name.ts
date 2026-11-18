/**
 * A deployment environment name: lowercase letters, digits and inner dashes, 1-63 characters,
 * so it can be a DNS label. The API enforces it on create; the web app checks it before
 * creating, and before putting a name into a pre-filled chat request.
 */
export const DEPLOYMENT_ENVIRONMENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
