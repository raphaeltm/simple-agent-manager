/** URL-driven view state so every screen of the prototype can be deep-linked and screenshotted. */
export type View = 'overview' | 'detail' | 'new' | 'history' | 'behind' | 'empty' | 'chat';
export type NewStep = 'when' | 'schedule' | 'do' | 'review';
export type BehindTab = 'waiting' | 'channels';

export interface Nav {
  overview: () => void;
  detail: (id: string) => void;
  create: (step: NewStep) => void;
  history: (automationId?: string) => void;
  behind: (tab: BehindTab) => void;
}
