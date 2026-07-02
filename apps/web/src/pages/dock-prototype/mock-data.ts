// Mock data + concept enums for the completion-dock prototype.
// Self-contained: no API calls, no auth.

export type AgentState = 'idle' | 'working';

// Label variants we are researching for the interrupt action.
export const INTERRUPT_LABELS = ['Stop', 'Pause', 'Cancel'] as const;
export type InterruptLabel = (typeof INTERRUPT_LABELS)[number];

// Label variants we are researching for the end-of-conversation action.
export const ARCHIVE_LABELS = ['Archive', 'Done', 'Wrap up', 'Complete'] as const;
export type ArchiveLabel = (typeof ARCHIVE_LABELS)[number];

// The three dock layout concepts to compare side by side.
export const DOCK_CONCEPTS = [
  { id: 'bump', name: 'A · Animated bump', hint: 'Center circular button in a morphing SVG notch' },
  { id: 'morph', name: 'B · Morphing center', hint: 'One button that changes identity: Stop while working, Archive while idle' },
  { id: 'flat', name: 'C · Flat balanced bar', hint: 'Conventional flat dock, controls flank the center' },
] as const;
export type DockConceptId = (typeof DOCK_CONCEPTS)[number]['id'];

// A short fake transcript so the dock sits above realistic content.
export const MOCK_MESSAGES: { role: 'user' | 'agent'; text: string }[] = [
  { role: 'user', text: 'Can you refactor the auth middleware to use the new error handler pattern?' },
  {
    role: 'agent',
    text: "I'll start by reading the current middleware and the error handler it should use. Then I'll migrate each route handler to throw AppError and rely on the global onError hook.",
  },
  { role: 'user', text: 'Sounds good. Make sure the subrouter errors still propagate.' },
  {
    role: 'agent',
    text: "Good call — that's the exact trap the api-patterns rule warns about. I'll verify the onError handler catches subrouter throws with a test that mounts a failing subrouter.",
  },
];
