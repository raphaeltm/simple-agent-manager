import { describe, expect, it } from 'vitest';

import { type PathQuestion, QUESTIONS } from '../../../src/components/onboarding/choose-path/questions';

describe('QUESTIONS graph validation', () => {
  const questionMap = new Map<string, PathQuestion>(
    QUESTIONS.map((q) => [q.id, q])
  );

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
      expect(
        reachable.has(q.id),
        `question "${q.id}" is unreachable from root`
      ).toBe(true);
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
        expect(o.description.trim().length, `option "${o.id}" description is empty`).toBeGreaterThan(0);
        expect(o.icon.trim().length, `option "${o.id}" icon is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('every question has non-empty question and description', () => {
    for (const q of QUESTIONS) {
      expect(q.question.trim().length, `question "${q.id}" has empty question`).toBeGreaterThan(0);
      expect(q.description.trim().length, `question "${q.id}" has empty description`).toBeGreaterThan(0);
    }
  });

  // ── Tag completeness ──

  it('terminal options always produce at least one tag', () => {
    for (const q of QUESTIONS) {
      for (const o of q.options) {
        if (o.next === null) {
          expect(
            o.tags.length,
            `terminal option "${o.id}" in question "${q.id}" has no tags`
          ).toBeGreaterThan(0);
        }
      }
    }
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

    // 3 AI choices × 2 cloud choices × 2 github choices = 12 paths
    // BUT api-key goes to which-api-key (2 sub-choices), so:
    // 1 (claude-pro) + 2 (api-key → anthropic/openai) + 1 (nothing) = 4 AI paths
    // 4 × 2 cloud × 2 github = 16 paths
    expect(allPaths.length).toBe(16);

    // Every path includes a cloud tag
    for (const path of allPaths) {
      const hasCloud = path.includes('byoc') || path.includes('sam-infra');
      expect(hasCloud, `path [${path.join(', ')}] has no cloud tag`).toBe(true);
    }

    // Every path includes a github tag
    for (const path of allPaths) {
      const hasGithub = path.includes('has-repo') || path.includes('no-repo');
      expect(hasGithub, `path [${path.join(', ')}] has no github tag`).toBe(true);
    }
  });
});
