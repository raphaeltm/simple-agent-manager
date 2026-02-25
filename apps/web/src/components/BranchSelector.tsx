import { useState, useEffect, useRef, useMemo } from 'react';
import { Input, Spinner } from '@simple-agent-manager/ui';

interface BranchSelectorProps {
  id?: string;
  branches: Array<{ name: string }>;
  value: string;
  onChange: (value: string) => void;
  defaultBranch?: string;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
}

export function BranchSelector({
  id,
  branches,
  value,
  onChange,
  defaultBranch,
  loading = false,
  error,
  disabled = false,
  placeholder = 'Search or type branch name',
  compact = false,
}: BranchSelectorProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const filteredBranches = useMemo(() => {
    if (!value) {
      // When empty, show all branches with default pinned to top
      if (defaultBranch) {
        const rest = branches.filter((b) => b.name !== defaultBranch);
        const def = branches.find((b) => b.name === defaultBranch);
        return def ? [def, ...rest] : rest;
      }
      return branches;
    }

    const searchTerm = value.toLowerCase();
    const matching = branches.filter((b) =>
      b.name.toLowerCase().includes(searchTerm)
    );

    // Pin default branch to top if it matches
    if (defaultBranch) {
      const defIndex = matching.findIndex((b) => b.name === defaultBranch);
      if (defIndex > 0) {
        const [def] = matching.splice(defIndex, 1);
        matching.unshift(def);
      }
    }

    return matching;
  }, [branches, value, defaultBranch]);

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(-1);
  }, [filteredBranches.length]);

  // Click-outside to close
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex < 0 || !dropdownRef.current) return;
    const items = dropdownRef.current.querySelectorAll('[data-branch-item]');
    items[highlightIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightIndex]);

  const handleSelect = (branchName: string) => {
    onChange(branchName);
    setShowDropdown(false);
    setHighlightIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown || filteredBranches.length === 0) {
      if (e.key === 'ArrowDown' && branches.length > 0) {
        setShowDropdown(true);
        e.preventDefault();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIndex((i) =>
          i < filteredBranches.length - 1 ? i + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIndex((i) =>
          i > 0 ? i - 1 : filteredBranches.length - 1
        );
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIndex >= 0 && highlightIndex < filteredBranches.length) {
          handleSelect(filteredBranches[highlightIndex].name);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowDropdown(false);
        setHighlightIndex(-1);
        break;
    }
  };

  const inputHeight = compact ? 36 : undefined;

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => {
            if (branches.length > 0) {
              setShowDropdown(true);
            }
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          style={compact ? { minHeight: inputHeight, fontSize: 13 } : undefined}
        />
        {loading && (
          <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <Spinner size="sm" />
          </div>
        )}
      </div>

      {showDropdown && filteredBranches.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            zIndex: 'var(--sam-z-dropdown)' as unknown as number,
            width: '100%',
            marginTop: '4px',
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            boxShadow: 'var(--sam-shadow-overlay)',
            maxHeight: compact ? '12rem' : '15rem',
            overflowY: 'auto',
          }}
        >
          {filteredBranches.map((branch, index) => {
            const isDefault = branch.name === defaultBranch;
            const isHighlighted = index === highlightIndex;
            return (
              <button
                key={branch.name}
                type="button"
                data-branch-item
                onClick={() => handleSelect(branch.name)}
                className="sam-hover-surface"
                style={{
                  width: '100%',
                  padding: compact ? '0.375rem 0.625rem' : '0.5rem 0.75rem',
                  textAlign: 'left',
                  background: isHighlighted
                    ? 'var(--sam-color-bg-surface-hover, rgba(255,255,255,0.06))'
                    : 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--sam-color-fg-primary)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                  <span
                    style={{
                      fontWeight: isDefault ? 600 : 500,
                      fontSize: compact ? '12px' : 'var(--sam-type-secondary-size)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {branch.name}
                  </span>
                  {isDefault && (
                    <span
                      style={{
                        padding: '1px 6px',
                        fontSize: '0.7rem',
                        backgroundColor: 'var(--sam-color-accent-primary)',
                        color: '#fff',
                        borderRadius: 'var(--sam-radius-sm)',
                        flexShrink: 0,
                      }}
                    >
                      default
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {showDropdown && value && filteredBranches.length === 0 && branches.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            zIndex: 'var(--sam-z-dropdown)' as unknown as number,
            width: '100%',
            marginTop: '4px',
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            boxShadow: 'var(--sam-shadow-overlay)',
            padding: '0.5rem 0.75rem',
          }}
        >
          <span style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
            No matching branches
          </span>
        </div>
      )}

      {error && (
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-fg-muted)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
