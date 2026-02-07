import { useState, useEffect, useRef } from 'react';
import { listRepositories } from '../lib/api';
import { Input, Spinner } from '@simple-agent-manager/ui';
import type { Repository } from '@simple-agent-manager/shared';

interface RepoSelectorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
}

export function RepoSelector({
  id,
  value,
  onChange,
  disabled = false,
  required = false,
  placeholder = 'https://github.com/user/repo or select from list',
}: RepoSelectorProps) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<Repository[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    if (!value || value.startsWith('http') || value.startsWith('git@')) {
      setFilteredRepos([]);
      return;
    }

    const searchTerm = value.toLowerCase();
    const filtered = repositories.filter(
      (repo) => repo.fullName.toLowerCase().includes(searchTerm)
    );

    setFilteredRepos(filtered.slice(0, 10)); // Limit to 10 results
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

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);

    // Show dropdown if we have repos and user is typing
    if (repositories.length > 0 && newValue && !newValue.startsWith('http') && !newValue.startsWith('git@')) {
      setShowDropdown(true);
    }
  };

  const handleRepoSelect = (repo: Repository) => {
    onChange(`https://github.com/${repo.fullName}`);
    setShowDropdown(false);
  };

  const handleFocus = () => {
    if (repositories.length > 0 && value && !value.startsWith('http') && !value.startsWith('git@')) {
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

      {/* Info message if GitHub not connected */}
      {error && repositories.length === 0 && value && !value.startsWith('http') && !value.startsWith('git@') && (
        <p style={{ marginTop: 'var(--sam-space-1)', fontSize: '0.75rem', color: 'var(--sam-color-fg-muted)' }}>
          Connect GitHub App for repository autocomplete
        </p>
      )}
    </div>
  );
}
