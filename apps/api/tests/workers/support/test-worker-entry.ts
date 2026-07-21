/**
 * Test-only worker entry for the Miniflare workers pool
 * (see `vitest.workers.config.ts` -> `main`).
 *
 * It re-exports the real API worker UNCHANGED — its default fetch/scheduled
 * handler and every Durable Object class — so `SELF`, all routes, and every
 * existing DO binding behave exactly as when `main` pointed at `src/index.ts`.
 *
 * It additionally exports `VmAgentContainerTestDouble` so the pool can bind
 * `VM_AGENT_CONTAINER` to a container-less stand-in. The real `VmAgentContainer`
 * cannot be instantiated under vitest-pool-workers (its `Container` base throws
 * when `ctx.container === undefined`); see `vm-agent-container-double.ts`. This
 * wrapper is required because vitest-pool-workers only resolves DO classes and
 * the default handler from the `main` module (and only `main` is transformed by
 * Vite, so the double can import the real TypeScript lifecycle helpers).
 */
export * from '../../../src/index';
export { default } from '../../../src/index';
export { VmAgentContainerTestDouble } from './vm-agent-container-double';
