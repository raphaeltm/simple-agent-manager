import type { AgentModelCatalogEntry, AgentModelCategory } from '@simple-agent-manager/shared';
import { AGENT_MODEL_CATEGORIES } from '@simple-agent-manager/shared';

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

/**
 * "3 models — clef-flash, clairic, bge-reranker-base" / "No models" / falls
 * back to the raw id for a selection the catalog doesn't (or no longer)
 * recognize, so a stale id still reads as something rather than disappearing.
 */
export function summarizeModelSelection(
  ids: readonly string[],
  catalogById: ReadonlyMap<string, AgentModelCatalogEntry>,
  maxNames = 3
): string {
  if (ids.length === 0) return 'No models';
  const names = ids.map((id) => catalogById.get(id)?.name ?? id);
  const shown = names.slice(0, maxNames).join(', ');
  const remaining = names.length - maxNames;
  const countLabel = `${ids.length} model${ids.length === 1 ? '' : 's'}`;
  return remaining > 0 ? `${countLabel} — ${shown} +${remaining} more` : `${countLabel} — ${shown}`;
}
