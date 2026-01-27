import { useState, useEffect, useRef } from 'react';
import { listRepositories } from '../lib/api';
import type { Repository } from '@cloud-ai-workspaces/shared';

interface RepoSelectorProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  placeholder?: string;
}

export function RepoSelector({
  id,
  value,
  onChange,
  disabled = false,
  required = false,
  className = '',
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
    <div className="relative">
      <div className="flex items-center">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          className={`flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500 ${className}`}
        />
        {loading && (
          <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
            <svg
              className="animate-spin h-4 w-4 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Dropdown with repository suggestions */}
      {showDropdown && filteredRepos.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto"
        >
          {filteredRepos.map((repo) => (
            <button
              key={repo.fullName}
              type="button"
              onClick={() => handleRepoSelect(repo)}
              className="w-full px-3 py-2 text-left hover:bg-gray-100 focus:bg-gray-100 focus:outline-none transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{repo.fullName}</span>
                    {repo.private && (
                      <span className="px-1.5 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded">
                        Private
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Info message if GitHub not connected */}
      {error && repositories.length === 0 && value && !value.startsWith('http') && !value.startsWith('git@') && (
        <p className="mt-1 text-xs text-gray-500">
          Connect GitHub App for repository autocomplete
        </p>
      )}
    </div>
  );
}
