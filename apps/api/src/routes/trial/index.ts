import { Hono } from 'hono';

import type { Env } from '../../env';
import { claimRoutes } from './claim';
import { createRoutes } from './create';
import { eventsRoutes } from './events';
import { statusRoutes } from './status';
import { waitlistRoutes } from './waitlist';

/**
 * Trial onboarding routes — mounted at `/api/trial`.
 *
 * Wave-0 stubs only; each handler returns 501. Wave-1 wires real behaviour.
 * The five subrouters are kept in separate files so the parallel Wave-1
 * tracks can evolve them without merge conflicts.
 *
 * Note: per-route middleware is used inside each subrouter (not a wildcard
 * middleware on this parent) — see `.claude/rules/06-api-patterns.md` on
 * Hono middleware scope leakage.
 */
const trialOnboardingRoutes = new Hono<{ Bindings: Env }>();

trialOnboardingRoutes.route('/', createRoutes);
trialOnboardingRoutes.route('/', eventsRoutes);
trialOnboardingRoutes.route('/', claimRoutes);
trialOnboardingRoutes.route('/', waitlistRoutes);
trialOnboardingRoutes.route('/', statusRoutes);

export { trialOnboardingRoutes };
