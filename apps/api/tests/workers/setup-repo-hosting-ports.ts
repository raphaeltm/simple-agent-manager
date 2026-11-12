/**
 * Install the worker's repo-hosting ports in the workerd test pool. Tests here import route
 * handlers and services directly rather than through the worker entry, so they need the same
 * wiring the entry performs (`src/repo-hosting-wiring.ts`).
 */
import '../../src/repo-hosting-wiring';
