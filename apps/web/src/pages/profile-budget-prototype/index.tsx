/**
 * PROTOTYPE — never merge to main. Agent Profiles that answer "which agent
 * should I use next?" by showing each account's remaining plan budget.
 * Route: /prototype/profile-budgets?v=profiles|accounts|reset
 */
import { Button, SegmentedControl } from '@simple-agent-manager/ui';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';

import { ResetComparison } from './ResetComparison';
import { VariantAccounts } from './VariantAccounts';
import { VariantProfiles } from './VariantProfiles';

const VARIANTS = [
  { id: 'profiles', label: 'A · Profiles' },
  { id: 'accounts', label: 'B · By account' },
  { id: 'reset', label: 'Reset fix' },
] as const;
type VariantId = (typeof VARIANTS)[number]['id'];

export function ProfileBudgetPrototype() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('v');
  const variant: VariantId = VARIANTS.some((v) => v.id === requested)
    ? (requested as VariantId)
    : 'profiles';

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-testid="prototype-scroll">
      <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="m-0 text-lg font-semibold text-fg-primary">Agent Profiles</h1>
          <Button size="sm">
            <Plus className="mr-1 inline-block h-4 w-4" />
            New
          </Button>
        </div>
        <div className="mb-4">
          <SegmentedControl
            label="Prototype variant"
            value={variant}
            onChange={(id) => setParams({ v: id }, { replace: true })}
            options={VARIANTS.map((v) => ({ value: v.id, label: v.label }))}
          />
        </div>
        {variant === 'profiles' && <VariantProfiles />}
        {variant === 'accounts' && <VariantAccounts />}
        {variant === 'reset' && <ResetComparison />}
      </div>
    </div>
  );
}
