import { describe, expect, it } from 'vitest';

import {
  type PathQuestion,
  QUESTIONS,
  questionsFor,
} from '../../../src/components/onboarding/choose-path/questions';

describe('QUESTIONS graph validation', () => {
  const questionMap = new Map<string, PathQuestion>(QUESTIONS.map((q) => [q.id, q]));

  // ── Structural integrity ──

  it('has no duplicate question IDs', () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('has no duplicate option IDs within a question', () => {
    for (const q of QUESTIONS) {
      const optIds = q.options.map((o) => o.id);
      expect(optIds, `duplicates in question "${q.id}"`).toEqual([...new Set(optIds)]);
    }
  });

  it('every option.next references a valid question ID or is null', () => {
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        if (o.next !== null) {
          expect(
            questionMap.has(o.next),
            `option "${o.id}" in question "${q.id}" references non-existent question "${o.next}"`
          ).toBe(true);
        }
      }
    }
  });

  it('every non-terminal question is reachable from the root', () => {
    const root = QUESTIONS[0];
    expect(root).toBeDefined();

    const reachable = new Set<string>();
    const queue = [root!.id];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);

      const q = questionMap.get(id);
      if (!q) continue;
      for (const o of q.options) {
        if (o.next !== null) queue.push(o.next);
      }
    }

    for (const q of QUESTIONS) {
      expect(reachable.has(q.id), `question "${q.id}" is unreachable from root`).toBe(true);
    }
  });

  // ── Termination (acyclicity) ──

  it('all paths terminate (no cycles)', () => {
    function walk(questionId: string, visited: Set<string>): boolean {
      if (visited.has(questionId)) return false; // cycle detected
      visited.add(questionId);
      const q = questionMap.get(questionId);
      if (!q) return false;
      for (const o of q.options) {
        if (o.next === null) continue; // terminal
        if (!walk(o.next, new Set(visited))) return false;
      }
      return true;
    }

    expect(walk(QUESTIONS[0]!.id, new Set())).toBe(true);
  });

  it('every path through the graph reaches at least one terminal option (next: null)', () => {
    function hasTerminal(questionId: string): boolean {
      const q = questionMap.get(questionId);
      if (!q) return false;
      return q.options.some((o) => {
        if (o.next === null) return true;
        return hasTerminal(o.next);
      });
    }

    expect(hasTerminal(QUESTIONS[0]!.id)).toBe(true);
  });

  // ── Content validation ──

  it('every question has at least 2 options', () => {
    for (const q of QUESTIONS) {
      expect(
        q.options.length,
        `question "${q.id}" has fewer than 2 options`
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('every option has non-empty label, description, and icon', () => {
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        expect(o.label.trim().length, `option "${o.id}" label is empty`).toBeGreaterThan(0);
        expect(
          o.description.trim().length,
          `option "${o.id}" description is empty`
        ).toBeGreaterThan(0);
        expect(o.icon.trim().length, `option "${o.id}" icon is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every question has non-empty question and description', () => {
    for (const q of QUESTIONS) {
      expect(q.question.trim().length, `question "${q.id}" has empty question`).toBeGreaterThan(0);
      expect(
        q.description.trim().length,
        `question "${q.id}" has empty description`
      ).toBeGreaterThan(0);
    }
  });

  // ── Tag vocabulary ──

  // The affirmative options add a tag (`byoc`, `has-repo`, `repo-artifacts`) and the
  // "not yet / SAM-managed" option carries no tag — its meaning IS the absence of the
  // tag. generatePath() branches on presence/absence, so empty-tag terminal options are
  // intentional, not a bug.
  it('only uses recognized tags (byoc, has-repo, repo-artifacts)', () => {
    const recognized = new Set(['byoc', 'has-repo', 'repo-artifacts']);
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        for (const t of o.tags) {
          expect(recognized.has(t), `option "${o.id}" emits unrecognized tag "${t}"`).toBe(true);
        }
      }
    }
  });

  it('every question offers exactly one untagged (absence) option', () => {
    for (const q of QUESTIONS) {
      const untagged = q.options.filter((o) => o.tags.length === 0);
      expect(untagged.length, `question "${q.id}" should have one untagged option`).toBe(1);
    }
  });

  // ── Installation capabilities ──

  it('offers SAM-hosted repositories only where Artifacts is enabled', () => {
    const repoOptions = (artifactsEnabled: boolean) =>
      questionsFor({ artifactsEnabled })
        .find((q) => q.id === 'repo-source')!
        .options.map((o) => o.id);
    expect(repoOptions(true)).toEqual(['sam-hosted', 'yes', 'no-repo']);
    expect(repoOptions(false)).toEqual(['yes', 'no-repo']);
  });

  // ── Path enumeration ──

  it('enumerates all possible tag combinations (complete path coverage)', () => {
    const allPaths: string[][] = [];

    function enumerate(questionId: string, tagsAccum: string[]) {
      const q = questionMap.get(questionId);
      if (!q) return;

      for (const o of q.options) {
        const newTags = [...tagsAccum, ...o.tags];
        if (o.next === null) {
          allPaths.push(newTags);
        } else {
          enumerate(o.next, newTags);
        }
      }
    }

    enumerate(QUESTIONS[0]!.id, []);

    // 2 cloud choices × 3 repository choices = 6 paths.
    expect(allPaths.length).toBe(6);

    const repo = (p: string[]) =>
      p.includes('repo-artifacts') ? 'sam' : p.includes('has-repo') ? 'repo' : '-';
    const signatures = allPaths
      .map((p) => `${p.includes('byoc') ? 'byoc' : '-'}/${repo(p)}`)
      .sort();
    expect(signatures).toEqual(['-/-', '-/repo', '-/sam', 'byoc/-', 'byoc/repo', 'byoc/sam']);
  });
});
