import type { SessionStateSnapshot } from './api';

export function parsePlanContent(content: string): SessionStateSnapshot['currentPlan'] | null {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
