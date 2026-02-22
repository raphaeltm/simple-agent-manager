import { useState, useEffect, useRef, useCallback } from 'react';
import { listRepositories } from '../lib/api';
import { Input, Spinner } from '@simple-agent-manager/ui';
import type { Repository } from '@simple-agent-manager/shared';

interface RepoSelectorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Called when a repository is selected from the dropdown with its metadata */
  onRepoSelect?: (repo: { fullName: string; defaultBranch: string; githubRepoId?: number } | null) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}

export function RepoSelector({
  id,
  value,
  onChange,
  onRepoSelect,
  disabled = false,
  required = false,
  placeholder = 'https://github.com/user/repo or select from list',
}: RepoSelectorProps) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<Repository[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedRepo, setLastCheckedRepo] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch GitHub repositories on mount
  useEffect(() => {
    const fetchRepos = async () => {
      setLoading(true);
      setError(null);
      try {
        const repos = await listRepositories();
        setRepositories(repos);
      } catch (err) {
        // Silently fail if GitHub not connected - user can still paste URLs
        console.log('Could not fetch GitHub repositories:', err);
        setError('GitHub not connected');
      } finally {
        setLoading(false);
      }
    };

    fetchRepos();
  }, []);

  // Filter repositories based on input
  useEffect(() => {
    if (value.startsWith('http') || value.startsWith('git@')) {
      setFilteredRepos([]);
      return;
    }

    if (!value) {
      setFilteredRepos(repositories.slice(0, 25));
      return;
    }

    const searchTerm = value.toLowerCase();
    const filtered = repositories.filter(
      (repo) => repo.fullName.toLowerCase().includes(searchTerm)
    );

    // Show more results (25) to help users with many repos find what they need
    setFilteredRepos(filtered.slice(0, 25));
  }, [value, repositories]);

  // Handle clicks outside dropdown
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

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // Extract repository name from URL
  const extractRepoName = useCallback((url: string): string | null => {
    // Handle various formats:
    // https://github.com/user/repo
    // https://github.com/user/repo.git
    // git@github.com:user/repo.git
    // user/repo
    let repoName = url;

    if (url.startsWith('https://github.com/')) {
      repoName = url.replace('https://github.com/', '');
    } else if (url.startsWith('git@github.com:')) {
      repoName = url.replace('git@github.com:', '');
    }

    // Remove .git suffix if present
    repoName = repoName.replace(/\.git$/, '');

    // Validate format (should be owner/repo)
    const parts = repoName.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return repoName;
    }

    return null;
  }, []);

  // Check if manually entered repo exists and get its default branch
  const checkManualRepo = useCallback((repoValue: string) => {
    const repoName = extractRepoName(repoValue);

    // Don't re-check the same repo
    if (!repoName || repoName === lastCheckedRepo) {
      return;
    }

    setLastCheckedRepo(repoName);

    // Check if this repo exists in our fetched list
    const foundRepo = repositories.find(r => r.fullName === repoName);
    if (foundRepo) {
      // We have metadata for this repo
      onRepoSelect?.({ fullName: foundRepo.fullName, defaultBranch: foundRepo.defaultBranch, githubRepoId: foundRepo.id });
    } else {
      // For manually entered repos not in the list, default to 'main'
      // The branch fetching will happen in CreateWorkspace component
      onRepoSelect?.({ fullName: repoName, defaultBranch: 'main' });
    }
  }, [repositories, lastCheckedRepo, extractRepoName, onRepoSelect]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    // Clear previous debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Show dropdown if we have repos and user is typing a search term
    if (repositories.length > 0 && !newValue.startsWith('http') && !newValue.startsWith('git@')) {
      setShowDropdown(true);
    } else {
      setShowDropdown(false);

      // For URLs, check after a delay to trigger branch fetching
      if (newValue && (newValue.startsWith('http') || newValue.startsWith('git@') || newValue.includes('/'))) {
        debounceTimerRef.current = setTimeout(() => {
          checkManualRepo(newValue);
        }, 500); // Wait 500ms after user stops typing
      }
    }
  };

  const handleRepoSelect = (repo: Repository) => {
    onChange(`https://github.com/${repo.fullName}`);
    onRepoSelect?.({ fullName: repo.fullName, defaultBranch: repo.defaultBranch, githubRepoId: repo.id });
    setShowDropdown(false);
  };

  const handleFocus = () => {
    if (repositories.length > 0 && !value.startsWith('http') && !value.startsWith('git@')) {
      setShowDropdown(true);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
        />
        {loading && (
          <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
            <Spinner size="sm" />
          </div>
        )}
      </div>

      {/* Dropdown with repository suggestions */}
      {showDropdown && filteredRepos.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            zIndex: 10,
            width: '100%',
            marginTop: '4px',
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
            borderRadius: 'var(--sam-radius-md)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
            maxHeight: '15rem',
            overflowY: 'auto',
          }}
        >
          {filteredRepos.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              onClick={() => handleRepoSelect(repo)}
              style={{
                width: '100%',
                padding: '0.5rem 0.75rem',
                textAlign: 'left',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--sam-color-fg-primary)',
                transition: 'background-color 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--sam-color-bg-surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sam-space-2)' }}>
                <span style={{ fontWeight: 500, fontSize: '0.875rem' }}>{repo.fullName}</span>
                {repo.private && (
                  <span style={{
                    padding: '1px 6px',
                    fontSize: '0.7rem',
                    backgroundColor: 'rgba(245, 158, 11, 0.15)',
                    color: '#fbbf24',
                    borderRadius: 'var(--sam-radius-sm)',
                  }}>
                    Private
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Status messages */}
      {loading && repositories.length === 0 && (
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          Loading repositories...
        </p>
      )}
      {error && repositories.length === 0 && value && !value.startsWith('http') && !value.startsWith('git@') && (
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          Connect GitHub App for repository autocomplete
        </p>
      )}
      {!loading && repositories.length > 0 && value && !value.startsWith('http') && !value.startsWith('git@') && filteredRepos.length === 0 && (
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          No matching repositories found
        </p>
      )}
    </div>
  );
}
