import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export interface WorkspaceTabItem {
  id: string;
  kind: 'terminal' | 'chat';
  sessionId: string;
  title: string;
  statusColor: string;
  badge?: string;
}

interface WorkspaceTabStripProps {
  tabs: WorkspaceTabItem[];
  activeTabId: string | null;
  isMobile: boolean;
  onSelect: (tab: WorkspaceTabItem) => void;
  onClose: (tab: WorkspaceTabItem) => void;
  onRename: (tab: WorkspaceTabItem, newName: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Slot for the create menu (+) button area */
  createMenuSlot: ReactNode;
}

const MAX_TAB_NAME_LENGTH = 50;
const LONG_PRESS_DELAY_MS = 500;

export function WorkspaceTabStrip({
  tabs,
  activeTabId,
  isMobile,
  onSelect,
  onClose,
  onRename,
  onReorder,
  createMenuSlot,
}: WorkspaceTabStripProps) {
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // DnD sensors: pointer with distance constraint to avoid accidental drags, keyboard for a11y
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  // Focus the input when entering edit mode
  useEffect(() => {
    if (editingTabId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingTabId]);

  const startRename = useCallback((tab: WorkspaceTabItem) => {
    setEditingTabId(tab.id);
    setEditValue(tab.title);
  }, []);

  const commitRename = useCallback(
    (tab: WorkspaceTabItem) => {
      const trimmed = editValue.trim().slice(0, MAX_TAB_NAME_LENGTH);
      setEditingTabId(null);
      if (trimmed && trimmed !== tab.title) {
        onRename(tab, trimmed);
      }
    },
    [editValue, onRename]
  );

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
  }, []);

  const handleDoubleClick = useCallback(
    (tab: WorkspaceTabItem) => {
      if (!isMobile) {
        startRename(tab);
      }
    },
    [isMobile, startRename]
  );

  const handleTouchStart = useCallback(
    (tab: WorkspaceTabItem) => {
      if (!isMobile) return;
      longPressTimerRef.current = setTimeout(() => {
        startRename(tab);
      }, LONG_PRESS_DELAY_MS);
    },
    [isMobile, startRename]
  );

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id || !onReorder) return;

      const fromIndex = tabs.findIndex((t) => t.id === active.id);
      const toIndex = tabs.findIndex((t) => t.id === over.id);
      if (fromIndex !== -1 && toIndex !== -1) {
        onReorder(fromIndex, toIndex);
      }
    },
    [onReorder, tabs]
  );

  // Cleanup long press timer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  const dragActiveTab = dragActiveId ? tabs.find((t) => t.id === dragActiveId) : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        backgroundColor: 'var(--sam-color-tn-bg-dark)',
        borderBottom: '1px solid var(--sam-color-tn-border)',
        height: isMobile ? 42 : 38,
        flexShrink: 0,
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        accessibility={{
          announcements: {
            onDragStart({ active }) {
              const tab = tabs.find((t) => t.id === active.id);
              return `Picked up tab ${tab?.title ?? active.id}`;
            },
            onDragOver({ active, over }) {
              if (!over) return '';
              const activeTab = tabs.find((t) => t.id === active.id);
              const overTab = tabs.find((t) => t.id === over.id);
              return `Tab ${activeTab?.title ?? active.id} is over ${overTab?.title ?? over.id}`;
            },
            onDragEnd({ active, over }) {
              if (!over) {
                const tab = tabs.find((t) => t.id === active.id);
                return `Tab ${tab?.title ?? active.id} was dropped`;
              }
              const activeTab = tabs.find((t) => t.id === active.id);
              const overTab = tabs.find((t) => t.id === over.id);
              return `Tab ${activeTab?.title ?? active.id} was placed ${over.id === active.id ? 'back in its original position' : `next to ${overTab?.title ?? over.id}`}`;
            },
            onDragCancel({ active }) {
              const tab = tabs.find((t) => t.id === active.id);
              return `Dragging tab ${tab?.title ?? active.id} was cancelled`;
            },
          },
        }}
      >
        <SortableContext items={tabs.map((t) => t.id)} strategy={horizontalListSortingStrategy}>
          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              overflowX: 'auto',
              flex: 1,
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
              WebkitOverflowScrolling: 'touch',
            }}
            role="tablist"
            aria-label="Workspace sessions"
          >
            {tabs.map((tab) => (
              <SortableTabWrapper
                key={tab.id}
                tab={tab}
                active={activeTabId === tab.id}
                hovered={hoveredTabId === tab.id}
                isEditing={editingTabId === tab.id}
                canClose
                isMobile={isMobile}
                editValue={editValue}
                editInputRef={editingTabId === tab.id ? editInputRef : undefined}
                dragDisabled={editingTabId !== null}
                onSelect={() => {
                  if (editingTabId !== tab.id) onSelect(tab);
                }}
                onDoubleClick={() => handleDoubleClick(tab)}
                onTouchStart={() => handleTouchStart(tab)}
                onTouchEnd={handleTouchEnd}
                onMouseEnter={() => setHoveredTabId(tab.id)}
                onMouseLeave={() => setHoveredTabId((prev) => (prev === tab.id ? null : prev))}
                onClose={() => onClose(tab)}
                onEditChange={(value) => setEditValue(value.slice(0, MAX_TAB_NAME_LENGTH))}
                onEditKeyDown={(key) => {
                  if (key === 'Enter') commitRename(tab);
                  else if (key === 'Escape') cancelRename();
                }}
                onEditBlur={() => commitRename(tab)}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {dragActiveTab ? <DragOverlayTab tab={dragActiveTab} isMobile={isMobile} /> : null}
        </DragOverlay>
      </DndContext>

      {createMenuSlot}

      <style>{`.sam-tab-close-btn:hover { background-color: var(--sam-color-tn-active) !important; color: var(--sam-color-tn-fg) !important; }`}</style>
    </div>
  );
}

// ── Sortable wrapper for each tab ──

interface SortableTabWrapperProps {
  tab: WorkspaceTabItem;
  active: boolean;
  hovered: boolean;
  isEditing: boolean;
  canClose: boolean;
  isMobile: boolean;
  editValue: string;
  editInputRef?: React.RefObject<HTMLInputElement>;
  dragDisabled: boolean;
  onSelect: () => void;
  onDoubleClick: () => void;
  onTouchStart: () => void;
  onTouchEnd: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose: () => void;
  onEditChange: (value: string) => void;
  onEditKeyDown: (key: string) => void;
  onEditBlur: () => void;
}

function SortableTabWrapper({
  tab,
  active,
  hovered,
  isEditing,
  canClose,
  isMobile,
  editValue,
  editInputRef,
  dragDisabled,
  onSelect,
  onDoubleClick,
  onTouchStart,
  onTouchEnd,
  onMouseEnter,
  onMouseLeave,
  onClose,
  onEditChange,
  onEditKeyDown,
  onEditBlur,
}: SortableTabWrapperProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    disabled: dragDisabled,
  });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={{
        ...sortableStyle,
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? 4 : 6,
        padding: isMobile ? '0 10px' : '0 12px',
        minWidth: isMobile ? 80 : 100,
        maxWidth: isMobile ? 150 : 180,
        cursor: isDragging ? 'grabbing' : 'pointer',
        fontSize: isMobile ? 12 : 13,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        border: 'none',
        borderRight: '1px solid var(--sam-color-tn-border)',
        position: 'relative',
        flexShrink: 0,
        whiteSpace: 'nowrap',
        backgroundColor: active ? 'var(--sam-color-tn-bg)' : hovered ? 'var(--sam-color-tn-surface)' : 'transparent',
        color: active || hovered ? 'var(--sam-color-tn-fg)' : 'var(--sam-color-tn-fg-muted)',
      }}
      onClick={() => {
        if (!isEditing && !isDragging) onSelect();
      }}
      onDoubleClick={onDoubleClick}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      {...attributes}
      {...listeners}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        // Forward to dnd-kit's keyboard handler first
        if (listeners?.onKeyDown) {
          (listeners.onKeyDown as (event: React.KeyboardEvent) => void)(event);
        }
        // Then handle tab activation
        if (!isEditing && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
      role="tab"
      aria-selected={active}
      aria-label={`${tab.kind === 'terminal' ? 'Terminal' : 'Chat'} tab: ${tab.title}`}
      aria-roledescription="sortable"
      tabIndex={0}
      title={tab.title}
    >
      {active && (
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: 'var(--sam-color-tn-blue)',
          }}
        />
      )}
      <span
        style={{
          display: 'inline-block',
          fontSize: 10,
          lineHeight: 1,
          color: tab.statusColor,
          flexShrink: 0,
        }}
      >
        ●
      </span>

      {isEditing ? (
        <input
          ref={editInputRef as React.RefObject<HTMLInputElement>}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              onEditKeyDown(e.key);
            }
            e.stopPropagation();
          }}
          onBlur={onEditBlur}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          maxLength={MAX_TAB_NAME_LENGTH}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'var(--sam-color-tn-surface)',
            border: '1px solid var(--sam-color-tn-blue)',
            borderRadius: 2,
            padding: '1px 4px',
            fontSize: 'inherit',
            fontFamily: 'inherit',
            color: 'var(--sam-color-tn-fg)',
            outline: 'none',
          }}
          aria-label="Rename tab"
        />
      ) : (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.title}
          </span>
          {tab.badge && (
            <span
              style={{
                fontSize: 10,
                lineHeight: 1,
                border: '1px solid var(--sam-color-tn-active)',
                borderRadius: 6,
                padding: '2px 5px',
                color: 'var(--sam-color-tn-blue)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {tab.badge}
            </span>
          )}
        </span>
      )}

      {canClose && !isEditing && (
        <button
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          className="sam-tab-close-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: isMobile ? 24 : 20,
            height: isMobile ? 24 : 20,
            borderRadius: 4,
            border: 'none',
            background: 'none',
            color: 'var(--sam-color-tn-fg-muted)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
            flexShrink: 0,
            opacity: isMobile ? 1 : active || hovered ? 1 : 0,
            transition: 'background-color 0.15s, color 0.15s',
          }}
          aria-label={tab.kind === 'terminal' ? `Close ${tab.title}` : `Stop ${tab.title}`}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Drag overlay (ghost tab) ──

function DragOverlayTab({ tab, isMobile }: { tab: WorkspaceTabItem; isMobile: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: isMobile ? 4 : 6,
        padding: isMobile ? '0 10px' : '0 12px',
        minWidth: isMobile ? 80 : 100,
        maxWidth: isMobile ? 150 : 180,
        height: isMobile ? 42 : 38,
        fontSize: isMobile ? 12 : 13,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: 'var(--sam-color-tn-surface)',
        border: '1px solid var(--sam-color-tn-blue)',
        borderRadius: 4,
        color: 'var(--sam-color-tn-fg)',
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
        cursor: 'grabbing',
      }}
    >
      <span style={{ fontSize: 10, lineHeight: 1, color: tab.statusColor }}>●</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {tab.title}
      </span>
    </div>
  );
}
