import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { getActiveUiStandard, upsertUiStandard, type UIStandard } from '../lib/ui-governance';

export function UiStandards() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const [version, setVersion] = useState('v1.0');
  const [status, setStatus] = useState<UIStandard['status']>('draft');
  const [name, setName] = useState('SAM Unified UI Standard');
  const [visualDirection, setVisualDirection] = useState('Green-forward, software-development-focused, high-clarity workflows');
  const [mobileFirstRulesRef, setMobileFirstRulesRef] = useState('docs/guides/mobile-ux-guidelines.md');
  const [accessibilityRulesRef, setAccessibilityRulesRef] = useState('docs/guides/ui-standards.md#accessibility-requirements');
  const [ownerRole, setOwnerRole] = useState('design-engineering-lead');

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        setError(null);
        const standard = await getActiveUiStandard();
        if (!mounted) return;
        setVersion(standard.version);
        setStatus(standard.status);
        setName(standard.name);
        setVisualDirection(standard.visualDirection);
        setMobileFirstRulesRef(standard.mobileFirstRulesRef);
        setAccessibilityRulesRef(standard.accessibilityRulesRef);
        setOwnerRole(standard.ownerRole);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'No active standard yet');
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSavedMessage(null);
    setError(null);
    try {
      await upsertUiStandard(version, {
        status,
        name,
        visualDirection,
        mobileFirstRulesRef,
        accessibilityRulesRef,
        ownerRole,
      });
      setSavedMessage('UI standard saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save standard');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button onClick={() => navigate('/dashboard')} className="text-gray-600 hover:text-gray-900">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-xl font-semibold text-gray-900">UI Standards</h1>
          </div>
          <UserMenu />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="p-8 flex justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
          </div>
        ) : (
          <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-6 space-y-4">
            {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700">{error}</div>}
            {savedMessage && <div className="p-3 bg-green-100 rounded-lg text-green-800">{savedMessage}</div>}

            <div>
              <label htmlFor="standard-version" className="block text-sm font-medium text-gray-700">Version</label>
              <input
                id="standard-version"
                type="text"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                required
              />
            </div>

            <div>
              <label htmlFor="standard-status" className="block text-sm font-medium text-gray-700">Status</label>
              <select
                id="standard-status"
                value={status}
                onChange={(e) => setStatus(e.target.value as UIStandard['status'])}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="draft">Draft</option>
                <option value="review">Review</option>
                <option value="active">Active</option>
                <option value="deprecated">Deprecated</option>
              </select>
            </div>

            <div>
              <label htmlFor="standard-name" className="block text-sm font-medium text-gray-700">Name</label>
              <input
                id="standard-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div>
              <label htmlFor="visual-direction" className="block text-sm font-medium text-gray-700">Visual Direction</label>
              <textarea
                id="visual-direction"
                value={visualDirection}
                onChange={(e) => setVisualDirection(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={3}
              />
            </div>

            <div>
              <label htmlFor="mobile-ref" className="block text-sm font-medium text-gray-700">Mobile Rules Reference</label>
              <input
                id="mobile-ref"
                type="text"
                value={mobileFirstRulesRef}
                onChange={(e) => setMobileFirstRulesRef(e.target.value)}
                required
              />
            </div>

            <div>
              <label htmlFor="accessibility-ref" className="block text-sm font-medium text-gray-700">Accessibility Rules Reference</label>
              <input
                id="accessibility-ref"
                type="text"
                value={accessibilityRulesRef}
                onChange={(e) => setAccessibilityRulesRef(e.target.value)}
                required
              />
            </div>

            <div>
              <label htmlFor="owner-role" className="block text-sm font-medium text-gray-700">Owner Role</label>
              <input
                id="owner-role"
                type="text"
                value={ownerRole}
                onChange={(e) => setOwnerRole(e.target.value)}
                required
              />
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                style={{ minHeight: '56px' }}
              >
                {saving ? 'Saving...' : 'Save Standard'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
