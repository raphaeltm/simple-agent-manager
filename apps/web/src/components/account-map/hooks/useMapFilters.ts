import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { Node, Edge } from '@xyflow/react';

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
  /** True when type filters changed and nodes were added/removed (signals auto-reorganize). */
  filterNodesChanged: boolean;
  /** Call after handling a filter-triggered reorganize to reset the signal. */
  clearFilterNodesChanged: () => void;
}

const ALL_TYPES: EntityType[] = ['project', 'node', 'workspace', 'session', 'task'];

export function useMapFilters({ nodes, edges }: UseMapFiltersOptions): UseMapFiltersResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<EntityType>>(() => new Set(ALL_TYPES));
  const [filterNodesChanged, setFilterNodesChanged] = useState(false);

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

  const clearFilterNodesChanged = useCallback(() => {
    setFilterNodesChanged(false);
  }, []);

  // Track previous filtered count to detect add/remove from type toggles
  const prevFilteredCountRef = useRef<number | null>(null);

  const { filteredNodes, filteredEdges, matchCount, totalCount } = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase().trim();

    // Type filter: fully REMOVE nodes whose type is toggled off
    const typeFiltered = nodes.filter((node) => {
      const entityType = NODE_TYPE_TO_ENTITY[node.type ?? ''];
      return entityType ? activeFilters.has(entityType) : true;
    });

    // Apply search — matching nodes get full opacity, non-matching get dimmed
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

    // Apply opacity styling (only for search dimming; type-filtered nodes are removed entirely)
    const styledNodes = typeFiltered.map((node) => ({
      ...node,
      style: {
        ...node.style,
        opacity: matchingIds.has(node.id) ? 1 : 0.15,
        transition: 'opacity 0.3s ease',
      },
    }));

    // Filter edges to only include those between visible (type-included) nodes
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

    return {
      filteredNodes: styledNodes,
      filteredEdges: styledEdges,
      matchCount: matchingIds.size,
      totalCount: typeFiltered.length,
    };
  }, [nodes, edges, searchQuery, activeFilters]);

  // Detect when type filtering changes the visible node count (triggers auto-reorganize)
  useEffect(() => {
    if (prevFilteredCountRef.current !== null && prevFilteredCountRef.current !== filteredNodes.length) {
      setFilterNodesChanged(true);
    }
    prevFilteredCountRef.current = filteredNodes.length;
  }, [filteredNodes.length]);

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
    filterNodesChanged,
    clearFilterNodesChanged,
  };
}
