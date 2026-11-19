import type { AgentModelCatalogEntry, AgentModelCategory } from '@simple-agent-manager/shared';
import { AGENT_MODEL_CATEGORIES, AGENT_MODEL_CATEGORY_LABELS } from '@simple-agent-manager/shared';

/** Above this many distinct categories, {@link summarizeModelsByCategory} truncates to the first 3 + "+N more". */
const MAX_SUMMARY_CATEGORIES = 4;

/** Builds `id -> entry` once per catalog fetch; every summary/lookup below takes this instead of re-scanning the array. */
export function indexCatalog(
  models: readonly AgentModelCatalogEntry[]
): ReadonlyMap<string, AgentModelCatalogEntry> {
  return new Map(models.map((model) => [model.id, model]));
}

/** Case-insensitive match against name, short id segment, author, description and category label. */
export function modelMatchesQuery(model: AgentModelCatalogEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    model.name.toLowerCase().includes(normalized) ||
    model.id.toLowerCase().includes(normalized) ||
    model.author.toLowerCase().includes(normalized) ||
    model.description.toLowerCase().includes(normalized) ||
    model.category.toLowerCase().includes(normalized) ||
    model.task.toLowerCase().includes(normalized)
  );
}

export interface ModelCategoryGroup {
  category: AgentModelCategory;
  /** Every model in this category, regardless of the active search/filter. */
  allModels: AgentModelCatalogEntry[];
  /** Models in this category that also match the current search query. */
  visibleModels: AgentModelCatalogEntry[];
  onCount: number;
  totalCount: number;
}

/**
 * Groups the catalog by category in `AGENT_MODEL_CATEGORIES` display order.
 * Categories with zero models are omitted entirely — the real catalog never
 * populates all eleven, and an empty "Translation" section with nothing under
 * it would just be noise.
 */
export function groupModelsByCategory(
  models: readonly AgentModelCatalogEntry[],
  selected: ReadonlySet<string>,
  query: string,
  onlyOn: boolean
): ModelCategoryGroup[] {
  const groups: ModelCategoryGroup[] = [];
  for (const category of AGENT_MODEL_CATEGORIES) {
    const allModels = models.filter((model) => model.category === category);
    if (allModels.length === 0) continue;
    const onCount = allModels.filter((model) => selected.has(model.id)).length;
    const visibleModels = allModels.filter((model) => {
      if (!modelMatchesQuery(model, query)) return false;
      if (onlyOn && !selected.has(model.id)) return false;
      return true;
    });
    groups.push({ category, allModels, visibleModels, onCount, totalCount: allModels.length });
  }
  return groups;
}

/** Ids the caller previously selected that no longer exist in the current catalog. */
export function findStaleModelIds(
  selected: readonly string[],
  catalogById: ReadonlyMap<string, AgentModelCatalogEntry>
): string[] {
  return selected.filter((id) => !catalogById.has(id));
}

export function toggleSetMember<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function setsHaveSameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function pluralModelCount(count: number): string {
  return `${count} model${count === 1 ? '' : 's'}`;
}

/**
 * "7 models (Decision 3 · Extraction 1 · Classification 3)" / "1 model
 * (Decision 1)" / "No models" — summarizes a selection by category (in
 * `AGENT_MODEL_CATEGORIES` display order) rather than by the first few names
 * in array order, which skewed toward whichever models happened to sort
 * first rather than anything meaningful to the person reading it. The
 * breakdown is parenthetical (not colon-joined) so callers can prefix it with
 * their own "label: " without producing a double colon, e.g. "The project's
 * choice: 7 models (...)".
 *
 * Above {@link MAX_SUMMARY_CATEGORIES} distinct categories, the breakdown
 * truncates to the first 3 plus a trailing "+N more" — joined by a single
 * space, not " · ", e.g. "Decision 3 · Extraction 1 · Text generation 5 +2
 * more" — "+N more" is a summary of the omitted categories, not another
 * category entry.
 *
 * Ids that no longer resolve in the catalog (stale/retired) are excluded
 * from both the count and the breakdown — a category summary should only
 * describe models that will actually run. Callers that also want to disclose
 * a stale count (the picker footer, which already shows a dedicated "No
 * longer available" section) append that separately, and only once the
 * catalog has actually loaded — see {@link summarizeRawSelectionCount}.
 */
export function summarizeModelsByCategory(
  ids: readonly string[],
  catalogById: ReadonlyMap<string, AgentModelCatalogEntry>
): string {
  const counts = new Map<AgentModelCategory, number>();
  let resolvedCount = 0;
  for (const id of ids) {
    const model = catalogById.get(id);
    if (!model) continue;
    resolvedCount += 1;
    counts.set(model.category, (counts.get(model.category) ?? 0) + 1);
  }
  if (resolvedCount === 0) return 'No models';

  const ordered = AGENT_MODEL_CATEGORIES.filter((category) => counts.has(category));
  const truncate = ordered.length > MAX_SUMMARY_CATEGORIES;
  const shown = truncate ? ordered.slice(0, 3) : ordered;
  const parts = shown.map(
    (category) => `${AGENT_MODEL_CATEGORY_LABELS[category]} ${counts.get(category)}`
  );
  let breakdown = parts.join(' · ');
  if (truncate) breakdown += ` +${ordered.length - 3} more`;

  return `${pluralModelCount(resolvedCount)} (${breakdown})`;
}

/**
 * A bare "N models" count, with no category breakdown — for the one place a
 * selection must be summarized BEFORE the catalog has loaded (the picker
 * footer while `catalogQuery` is loading or errored). Without a loaded
 * catalog, every id's category — and even whether it's stale — is unknown,
 * so `summarizeModelsByCategory` would (wrongly) report every selected id as
 * "no longer available". This reports only what's actually knowable: how
 * many ids are in the draft.
 */
export function summarizeRawSelectionCount(ids: readonly string[]): string {
  if (ids.length === 0) return 'No models';
  return pluralModelCount(ids.length);
}
