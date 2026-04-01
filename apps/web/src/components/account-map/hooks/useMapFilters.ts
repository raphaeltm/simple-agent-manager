import type { Edge,Node } from '@xyflow/react';
import { useCallback, useMemo, useRef,useState } from 'react';

export type EntityType = 'project' | 'node' | 'workspace' | 'session' | 'task' | 'idea';

const NODE_TYPE_TO_ENTITY: Record<string, EntityType> = {
  projectNode: 'project',
  nodeVMNode: 'node',
  workspaceNode: 'workspace',
  sessionNode: 'session',
  taskNode: 'task',
  ideaNode: 'idea',
};

interface UseMapFiltersOptions {
  nodes: Node[];
  edges: Edge[];
}

interface UseMapFiltersResult {
  filteredNodes: Node[];
  filteredEdges: Edge[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  activeFilters: Set<EntityType>;
  toggleFilter: (type: EntityType) => void;
  resetFilters: () => void;
  hasActiveFilters: boolean;
  matchCount: number;
  totalCount: number;
  /** True when type filters changed the visible node count — signals auto-reorganize. */
  filterNodeCountChanged: boolean;
}

const ALL_TYPES: EntityType[] = ['project', 'node', 'workspace', 'session', 'task'];

export function useMapFilters({ nodes, edges }: UseMapFiltersOptions): UseMapFiltersResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<EntityType>>(() => new Set(ALL_TYPES));
  const prevFilteredCountRef = useRef<number | null>(null);

  const toggleFilter = useCallback((type: EntityType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const resetFilters = useCallback(() => {
    setActiveFilters(new Set(ALL_TYPES));
    setSearchQuery('');
  }, []);

  const { filteredNodes, filteredEdges, matchCount, totalCount, filterNodeCountChanged } = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase().trim();

    // Type filters: fully REMOVE nodes whose type is toggled off
    const typeFiltered = nodes.filter((node) => {
      const entityType = NODE_TYPE_TO_ENTITY[node.type ?? ''];
      return entityType ? activeFilters.has(entityType) : true;
    });

    // Search: dim non-matching nodes (keep them visible for context)
    let matchingIds: Set<string>;
    if (lowerQuery) {
      matchingIds = new Set(
        typeFiltered
          .filter((node) => {
            const label = (node.data?.label as string) ?? '';
            const extra = [
              node.data?.repository,
              node.data?.branch,
              node.data?.ipAddress,
              node.data?.vmLocation,
              node.data?.topic,
              node.data?.status,
            ]
              .filter(Boolean)
              .join(' ');
            return (
              label.toLowerCase().includes(lowerQuery) ||
              extra.toLowerCase().includes(lowerQuery)
            );
          })
          .map((n) => n.id)
      );
    } else {
      matchingIds = new Set(typeFiltered.map((n) => n.id));
    }

    // Apply opacity styling for search matches (type-filtered nodes are fully removed above)
    const styledNodes = typeFiltered.map((node) => ({
      ...node,
      style: {
        ...node.style,
        opacity: matchingIds.has(node.id) ? 1 : 0.15,
        transition: 'opacity 0.3s ease',
      },
    }));

    // Filter edges: only between type-visible nodes
    const visibleIds = new Set(typeFiltered.map((n) => n.id));
    const edgesFiltered = edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    // Dim edges where either end is search-dimmed
    const styledEdges = edgesFiltered.map((edge) => ({
      ...edge,
      style: {
        ...edge.style,
        opacity:
          matchingIds.has(edge.source) && matchingIds.has(edge.target) ? 1 : 0.15,
        transition: 'opacity 0.3s ease',
      },
    }));

    // Detect if the type filter changed the visible node count (triggers auto-reorganize)
    const currentCount = typeFiltered.length;
    const changed = prevFilteredCountRef.current !== null && prevFilteredCountRef.current !== currentCount;
    prevFilteredCountRef.current = currentCount;

    return {
      filteredNodes: styledNodes,
      filteredEdges: styledEdges,
      matchCount: matchingIds.size,
      totalCount: typeFiltered.length,
      filterNodeCountChanged: changed,
    };
  }, [nodes, edges, searchQuery, activeFilters]);

  const hasActiveFilters = activeFilters.size < ALL_TYPES.length || searchQuery.length > 0;

  return {
    filteredNodes,
    filteredEdges,
    searchQuery,
    setSearchQuery,
    activeFilters,
    toggleFilter,
    resetFilters,
    hasActiveFilters,
    matchCount,
    totalCount,
    filterNodeCountChanged,
  };
}
