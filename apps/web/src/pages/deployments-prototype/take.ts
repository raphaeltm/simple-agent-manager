/**
 * PROTOTYPE — two redesign takes for the deployment pages (task 01M5N1SJZHRS7VKWX2DPCJ0P08).
 * Never merge to main (`apps/web/.claude/rules/37-prototype-development.md`).
 *
 * `?take=a` or `?take=b` on the real Deployments routes swaps in a take. The switch only
 * works in dev and test builds, so a production bundle always renders the current pages.
 */
import { useSearchParams } from 'react-router';

export type Take = 'a' | 'b';

function prototypesEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

export function useTake(): Take | null {
  const [params] = useSearchParams();
  if (!prototypesEnabled()) return null;
  const value = params.get('take');
  return value === 'a' || value === 'b' ? value : null;
}

/** Keeps the take in links so navigating between list and detail stays inside it. */
export function withTake(path: string, take: Take, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  params.set('take', take);
  return `${path}?${params.toString()}`;
}
