/**
 * The celld entry's view of runtime-secrets.ts: the same wrappers, with this isolate reaching the
 * key agent through `cloudflare:sockets` (a raw TCP socket, never `fetch`; see that module's
 * comment for why). Imported only by the generated celld entry (scripts/selfhost/celld-project.ts).
 */
// eslint-disable-next-line sam/no-unguarded-outbound-fetch -- runtime-secrets.ts connects only to the deploy-pinned loopback agent (127.0.0.1:<port>, checked in its settings())
import { connect } from 'cloudflare:sockets';

import { useKeyAgentSocket } from './runtime-secrets';
import { wrapDurableObject } from './runtime-secrets-durable-object';
import { wrapWorker } from './runtime-secrets-worker';

useKeyAgentSocket(connect);

export { wrapDurableObject, wrapWorker };
