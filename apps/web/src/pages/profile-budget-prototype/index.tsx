/**
 * PROTOTYPE — never merge to main. Agent Profiles that answer "which agent
 * should I use next?" by showing each account's remaining plan budget.
 * Route: /prototype/profile-budgets?v=strip|table|ring|reset
 */
import { Button, SegmentedControl } from '@simple-agent-manager/ui';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'react-router';

import { ResetComparison } from './ResetComparison';
import { VariantRing } from './VariantRing';
import { VariantStrip } from './VariantStrip';
import { VariantTable } from './VariantTable';

const VARIANTS = [
  { id: 'strip', label: 'A1 Strip' },
  { id: 'table', label: 'A2 Table' },
  { id: 'ring', label: 'A3 Ring' },
  { id: 'reset', label: 'Reset' },
] as const;
type VariantId = (typeof VARIANTS)[number]['id'];

export function ProfileBudgetPrototype() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('v');
  const variant: VariantId = VARIANTS.some((v) => v.id === requested)
    ? (requested as VariantId)
    : 'strip';

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-testid="prototype-scroll">
      <div className="mx-auto w-full min-w-0 max-w-4xl px-4 py-6">
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
        {variant === 'strip' && <VariantStrip />}
        {variant === 'table' && <VariantTable />}
        {variant === 'ring' && <VariantRing />}
        {variant === 'reset' && <ResetComparison />}
      </div>
    </div>
  );
}
