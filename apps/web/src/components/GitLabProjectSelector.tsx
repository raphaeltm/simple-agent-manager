import type { GitLabProject } from '@simple-agent-manager/shared';
import { Alert, Input, Spinner } from '@simple-agent-manager/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { listGitLabProjects } from '../lib/api';

interface GitLabProjectSelectorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onProjectSelect: (project: GitLabProject | null) => void;
  disabled?: boolean;
}

export function GitLabProjectSelector({
  id,
  value,
  onChange,
  onProjectSelect,
  disabled = false,
}: GitLabProjectSelectorProps) {
  const [projects, setProjects] = useState<GitLabProject[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    listGitLabProjects()
      .then((result) => {
        if (!active) return;
        setProjects(result.projects);
      })
      .catch((err) => {
        if (!active) return;
        setProjects([]);
        setError(err instanceof Error ? err.message : 'Unable to load GitLab projects');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredProjects = useMemo(() => {
    const search = value.trim().toLowerCase();
    if (!search) return projects.slice(0, 25);
    return projects
      .filter((project) => project.pathWithNamespace.toLowerCase().includes(search))
      .slice(0, 25);
  }, [projects, value]);

  const selectProject = (project: GitLabProject) => {
    onChange(project.pathWithNamespace);
    onProjectSelect(project);
    setShowDropdown(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center">
        <Input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            onProjectSelect(null);
            setShowDropdown(true);
          }}
          onFocus={() => {
            if (projects.length > 0) setShowDropdown(true);
          }}
          disabled={disabled}
          required
          placeholder="group/project"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Spinner size="sm" />
          </div>
        )}
      </div>

      {showDropdown &&
        filteredProjects.length > 0 &&
        createPortal(
          <div
            ref={dropdownRef}
            className="glass-surface"
            style={{
              position: 'fixed',
              zIndex: 'var(--sam-z-dropdown)' as unknown as number,
              ...(containerRef.current
                ? (() => {
                    const rect = containerRef.current!.getBoundingClientRect();
                    return { top: rect.bottom + 4, left: rect.left, width: rect.width };
                  })()
                : {}),
              borderRadius: 'var(--sam-radius-md)',
              boxShadow: 'var(--sam-shadow-overlay)',
              maxHeight: '15rem',
              overflowY: 'auto',
            }}
          >
            {filteredProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => selectProject(project)}
                className="sam-hover-surface"
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem',
                  textAlign: 'left',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--sam-color-fg-primary)',
                }}
              >
                <span className="block text-sm font-medium">{project.pathWithNamespace}</span>
                <span className="block text-xs text-fg-muted">{project.defaultBranch}</span>
              </button>
            ))}
          </div>,
          document.body
        )}

      {error && <Alert variant="warning">{error}</Alert>}
    </div>
  );
}
