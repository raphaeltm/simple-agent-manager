/**
 * Insights · People (slice P, idea 01M7HTS38KX2G78JD0ESAGMKKH): where a project's work waits on
 * people, never how much anyone produced. Served by `projectPeople`
 * (`packages/operations/src/insights-people.ts`) at
 * `GET /api/projects/:projectId/insights/people?range=…`.
 *
 * - Waiting on: open asks and human tasks right now, grouped by who they wait on, oldest first.
 *   An item the viewer could not open in the Inbox shows its age only: no title, kind or flags.
 * - Review pickup: time from a review being requested on a pull request to the first review, per
 *   project. Recorded from GitHub webhooks since slice P shipped; earlier requests are "not
 *   recorded", never estimated.
 * - First person: the share of closed asks answered by the person first asked, with no handoff.
 *
 * No count of anything a person produced appears here, per person or otherwise.
 */
import type { InsightsRange } from './insights-flow';

/** The ask kinds that wait on a person (system error items are excluded). */
export const INSIGHTS_PEOPLE_ASK_KINDS = ['question', 'review', 'task'] as const;
export type InsightsPeopleAskKind = (typeof INSIGHTS_PEOPLE_ASK_KINDS)[number];

export type InsightsPeopleSection = 'waiting' | 'reviews' | 'first_person';

/**
 * One open item. Everything but its age is null when the viewer may not open it in the Inbox
 * (`private: true`): the group's counts still include it.
 */
export interface InsightsWaitingItem {
  private: boolean;
  /** Inbox reference (`ask:<id>`); null when private. */
  ref: string | null;
  /** The item's title; null when private. */
  title: string | null;
  kind: InsightsPeopleAskKind | null;
  /** An agent is paused waiting on it; null when private. */
  blocking: boolean | null;
  /** A team task one member has taken: it waits on that member. Null when private. */
  claimed: boolean | null;
  createdAt: string;
  ageMs: number;
  /** True when the viewer may hand this task on through the Inbox (human tasks only). */
  canReassign: boolean;
}

export interface InsightsWaitingGroup {
  /** The member's user id, or `unassigned` for team items nobody has taken. */
  key: string;
  kind: 'person' | 'unassigned';
  userId: string | null;
  /**
   * Display name of an active member; null for the unassigned group and for someone who is no
   * longer an active member of the project.
   */
  name: string | null;
  /** False when the person is no longer an active member (their items still wait). */
  member: boolean;
  you: boolean;
  /** Open items in this group. */
  open: number;
  blocking: number;
  oldestAgeMs: number;
  /** Up to `listed` items, oldest first. */
  items: InsightsWaitingItem[];
}

export interface InsightsWaiting {
  /** Oldest wait first. */
  groups: InsightsWaitingGroup[];
  total: number;
  /** Most items shown per group; `open` says how many there are. */
  listed: number;
}

export type InsightsReviewPickup =
  | {
      state: 'recorded';
      /** Review requests in the range that got a first review. */
      samples: number;
      medianMs: number;
      p90Ms: number;
      /** Requests in the range still waiting for a first review. */
      waiting: number;
      /** When the earliest recorded request of this project was made; history before is unknown. */
      recordedSince: string;
      /** True when the scan cap cut the range short (newest requests were kept). */
      truncated: boolean;
    }
  | {
      state: 'not_recorded';
      /** Requests in the range still waiting (0 when nothing was recorded at all). */
      waiting: number;
      /** When recording began for this project, or null when no request was ever recorded. */
      recordedSince: string | null;
    };

export interface InsightsFirstPerson {
  /** Asks closed in the range whose first assignee was one person. */
  closed: number;
  /** Of those, answered by that person with no handoff. */
  firstPerson: number;
  /** `firstPerson / closed`, or null when nothing closed. */
  share: number | null;
}

export interface ProjectPeopleResponse {
  projectId: string;
  range: InsightsRange;
  since: string;
  until: string;
  waiting: InsightsWaiting;
  reviewPickup: InsightsReviewPickup;
  firstPerson: InsightsFirstPerson;
  /** Sections that could not be read; their values are empty, not zero. */
  unavailable: InsightsPeopleSection[];
  generatedAt: string;
}
