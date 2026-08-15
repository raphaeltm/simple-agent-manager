// ── Result types ──
//
// Shared result/item shapes for the global command palette. Split out of
// GlobalCommandPalette.tsx (see .claude/rules/18-file-size-limits.md) — pure
// type extraction, no behavior change.

export interface NavigationResult {
  kind: 'navigation';
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  score: number;
  matches: number[];
}

export interface ProjectResult {
  kind: 'project';
  id: string;
  label: string;
  path: string;
  score: number;
  matches: number[];
}

export interface NodeResult {
  kind: 'node';
  id: string;
  label: string;
  path: string;
  score: number;
  matches: number[];
}

export interface ChatResult {
  kind: 'chat';
  id: string;
  label: string;
  path: string;
  projectName: string;
  createdAt: number;
  score: number;
  matches: number[];
}

export interface ActionResult {
  kind: 'action';
  id: string;
  label: string;
  action: () => void;
  icon: React.ReactNode;
  score: number;
  matches: number[];
}

export type PaletteResult =
  | NavigationResult
  | ProjectResult
  | NodeResult
  | ChatResult
  | ActionResult;

export interface CategoryGroup {
  category: string;
  results: PaletteResult[];
}

/** A static navigation entry (before fuzzy-matching adds score/matches). */
export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
}

/** A static action entry (before fuzzy-matching adds score/matches). */
export interface ActionItem {
  id: string;
  label: string;
  action: () => void;
  icon: React.ReactNode;
}

export function resultKey(result: PaletteResult): string {
  return `${result.kind}:${result.id}`;
}
