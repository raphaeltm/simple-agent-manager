import type {
  AgentModelCatalogEntry,
  AgentModelCatalogResponse,
} from '@simple-agent-manager/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelPicker } from '../../../../src/components/agent-models/ModelPicker';
import { createTestQueryClient } from '../../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  getAgentModelCatalog: vi.fn(),
}));

vi.mock('../../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

vi.mock('../../../../src/lib/api/agent-models', () => ({
  getAgentModelCatalog: mocks.getAgentModelCatalog,
  getProjectAgentModelSettings: vi.fn(),
  updateProjectAgentModelSettings: vi.fn(),
}));

function makeModel(overrides: Partial<AgentModelCatalogEntry>): AgentModelCatalogEntry {
  return {
    id: 'm-unnamed',
    name: 'unnamed',
    author: 'cloudflare',
    description: 'A model.',
    category: 'decision',
    task: 'Text Generation',
    prices: [{ unit: 'per M input tokens', usd: 0.023 }],
    contextWindow: null,
    capabilities: [],
    beta: false,
    partner: false,
    infoUrl: null,
    termsUrl: null,
    ...overrides,
  };
}

const CATALOG: AgentModelCatalogResponse = {
  models: [
    makeModel({ id: 'm-decision-1', name: 'clef-flash', category: 'decision' }),
    makeModel({ id: 'm-decision-2', name: 'clef-omni', category: 'decision' }),
    makeModel({
      id: 'm-embed-1',
      name: 'bge-base',
      category: 'embeddings',
      description: 'Turn text into vectors for search and similarity.',
    }),
  ],
  defaultModelIds: ['m-decision-1'],
  defaultCategories: ['decision'],
  fetchedAt: '2026-10-01T00:00:00Z',
};

interface RenderOverrides {
  initialSelection?: string[];
  onSave?: (ids: string[]) => Promise<void>;
  isOpen?: boolean;
}

function renderPicker(overrides: RenderOverrides = {}) {
  const queryClient = createTestQueryClient();
  const onClose = vi.fn();
  const onSave = overrides.onSave ?? vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ModelPicker
        isOpen={overrides.isOpen ?? true}
        initialSelection={overrides.initialSelection ?? ['m-decision-1']}
        onClose={onClose}
        onSave={onSave}
      />
    </QueryClientProvider>
  );
  return { ...utils, onClose, onSave, queryClient };
}

describe('ModelPicker', () => {
  // Reset per test so a later `mockResolvedValueOnce`/`mockRejectedValueOnce`
  // override in one test can't leak into the next one.
  beforeEach(() => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getAgentModelCatalog.mockResolvedValue(CATALOG);
  });

  it('groups catalog models by category and reflects the initial selection', async () => {
    renderPicker();
    await screen.findByText('clef-omni');

    expect(screen.getByRole('switch', { name: /turn off clef-flash/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: /turn on clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByText('Decision')).toBeInTheDocument();
    expect(screen.getByText('Embeddings')).toBeInTheDocument();
  });

  it('toggling a model marks the draft dirty and enables Save', async () => {
    renderPicker();
    await screen.findByText('clef-omni');

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));

    expect(saveButton).toBeEnabled();
    expect(screen.getByRole('switch', { name: /turn off clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('search narrows the visible models by name and description', async () => {
    renderPicker();
    await screen.findByText('bge-base');

    fireEvent.change(screen.getByPlaceholderText('Search models'), {
      target: { value: 'vectors' },
    });

    expect(screen.queryByText('clef-flash')).not.toBeInTheDocument();
    expect(screen.getByText('bge-base')).toBeInTheDocument();
  });

  it('shows an empty-search message when nothing matches', async () => {
    renderPicker();
    await screen.findByText('clef-omni');

    fireEvent.change(screen.getByPlaceholderText('Search models'), {
      target: { value: 'no-such-model-xyz' },
    });

    expect(await screen.findByText('No models match "no-such-model-xyz".')).toBeInTheDocument();
  });

  it('distinguishes a genuinely empty catalog from an "On only" filter with nothing on', async () => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getAgentModelCatalog.mockResolvedValue({ ...CATALOG, models: [] });
    renderPicker({ initialSelection: [] });

    expect(await screen.findByText('No models are available right now.')).toBeInTheDocument();
  });

  it('"On only" with nothing toggled on shows its own distinct message', async () => {
    renderPicker({ initialSelection: [] });
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('button', { name: 'On only' }));

    expect(await screen.findByText('No models are on.')).toBeInTheDocument();
  });

  it('category bulk "All off" turns off every model in that category', async () => {
    renderPicker({ initialSelection: ['m-decision-1', 'm-decision-2'] });
    await screen.findByText('clef-omni');

    // Only "Decision" has 2 visible rows, so its bulk buttons are the only ones rendered.
    fireEvent.click(screen.getByRole('button', { name: 'All off' }));

    expect(screen.getByRole('switch', { name: /turn on clef-flash/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    expect(screen.getByRole('switch', { name: /turn on clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('category bulk "All on" turns on every model in that category', async () => {
    renderPicker({ initialSelection: [] });
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('button', { name: 'All on' }));

    expect(screen.getByRole('switch', { name: /turn off clef-flash/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: /turn off clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('asks for confirmation before discarding unsaved changes via the ambiguous close button', async () => {
    const { onClose } = renderPicker();
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));

    expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
    // The footer's own "Discard" is disabled while the banner is up (asserted
    // below), so scope this click to the banner's copy of the button.
    const banner = screen.getByRole('alert');
    fireEvent.click(within(banner).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables the footer actions while the confirm banner is showing (no duplicate affordance)', async () => {
    renderPicker();
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
    await screen.findByText('Discard unsaved changes?');

    const footerDiscard = screen
      .getAllByRole('button', { name: 'Discard' })
      .find((button) => !button.closest('[role="alert"]'));
    expect(footerDiscard).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('the footer Discard button closes immediately — its own label is the confirmation', async () => {
    const { onClose } = renderPicker();
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('Save sends the full current draft and closes on success', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { onClose } = renderPicker({ onSave });
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.arrayContaining(['m-decision-1', 'm-decision-2']))
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('shows an inline error and stays open when Save fails', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('monthly budget exceeded'));
    const { onClose } = renderPicker({ onSave });
    await screen.findByText('clef-omni');

    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('monthly budget exceeded')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('flags a selected id no longer in the catalog, excludes it from the footer count, and lets the user remove it', async () => {
    renderPicker({ initialSelection: ['m-decision-1', 'retired-model-id'] });

    expect(await screen.findByText('No longer available')).toBeInTheDocument();
    expect(screen.getByText('retired-model-id')).toBeInTheDocument();
    // The footer must not count the stale id as a model that will run — it
    // reports the 1 real selection plus a separate stale disclosure, not "2
    // models".
    expect(screen.getByText('1 model (Decision 1) · 1 no longer available')).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByText('retired-model-id')).not.toBeInTheDocument();
    expect(saveButton).toBeEnabled();
  });

  it('shows Retry on a catalog load error and recovers after a successful retry', async () => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getAgentModelCatalog.mockRejectedValueOnce(new Error('network down'));
    renderPicker({ initialSelection: [] });

    expect(await screen.findByText(/couldn.t load the model list/i)).toBeInTheDocument();

    mocks.getAgentModelCatalog.mockResolvedValueOnce(CATALOG);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('clef-flash');
  });

  it('while the catalog has errored, the footer shows a bare selection count — no category breakdown, no stale-ids suffix, no stale-ids banner', async () => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getAgentModelCatalog.mockRejectedValueOnce(new Error('network down'));
    renderPicker({ initialSelection: ['m-decision-1', 'm-decision-2', 'retired-model-id'] });

    expect(await screen.findByText(/couldn.t load the model list/i)).toBeInTheDocument();
    // Without a loaded catalog, every one of the 3 selected ids is
    // indistinguishable from "stale" (none resolve against an empty map) —
    // the footer must not report that, nor render the "No longer available"
    // banner, since we genuinely don't know yet.
    expect(screen.queryByText('No longer available')).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer available/)).not.toBeInTheDocument();
    expect(screen.getByText('3 models')).toBeInTheDocument();
  });

  it('while the catalog is still loading, the footer also shows a bare selection count', async () => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getAgentModelCatalog.mockReturnValue(new Promise(() => {})); // never resolves
    renderPicker({ initialSelection: ['m-decision-1', 'm-decision-2'] });

    expect(await screen.findByRole('status', { name: 'Loading models' })).toBeInTheDocument();
    expect(screen.queryByText('No longer available')).not.toBeInTheDocument();
    expect(screen.getByText('2 models')).toBeInTheDocument();
  });

  it('does not reseed the draft when `initialSelection` changes identity while already open', async () => {
    const queryClient = createTestQueryClient();
    const onSave = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-1']} onClose={vi.fn()} onSave={onSave} />
      </QueryClientProvider>
    );
    await screen.findByText('clef-omni');
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));

    // A brand-new array with the SAME values — mimics a background settings
    // refetch that resolved while the picker stayed open.
    rerender(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-1']} onClose={vi.fn()} onSave={onSave} />
      </QueryClientProvider>
    );

    expect(screen.getByRole('switch', { name: /turn off clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('CONTROL: reseeds the draft on a genuine closed -> open transition with a new selection', async () => {
    const queryClient = createTestQueryClient();
    const onSave = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-1']} onClose={vi.fn()} onSave={onSave} />
      </QueryClientProvider>
    );
    await screen.findByText('clef-omni');
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));

    rerender(
      <QueryClientProvider client={queryClient}>
        <ModelPicker
          isOpen={false}
          initialSelection={['m-decision-1']}
          onClose={vi.fn()}
          onSave={onSave}
        />
      </QueryClientProvider>
    );
    rerender(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-2']} onClose={vi.fn()} onSave={onSave} />
      </QueryClientProvider>
    );

    await screen.findByText('clef-omni');
    expect(screen.getByRole('switch', { name: /turn off clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: /turn on clef-flash/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('B2: the dirty baseline is frozen at open time — a background `initialSelection` change plus an unrelated interaction must not falsely mark the picker dirty', async () => {
    const queryClient = createTestQueryClient();
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-1']} onClose={onClose} onSave={onSave} />
      </QueryClientProvider>
    );
    await screen.findByText('clef-omni');

    // Control: before any background change, Save is disabled and the
    // dismiss button correctly reads "Close" — nothing to discard yet.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    // Simulate a background settings refetch while the picker stays open and
    // the user has not touched anything — e.g. another admin changed the
    // project's models in another tab.
    rerender(
      <QueryClientProvider client={queryClient}>
        <ModelPicker isOpen initialSelection={['m-decision-2']} onClose={onClose} onSave={onSave} />
      </QueryClientProvider>
    );

    // An unrelated interaction that touches zero model toggles: collapsing
    // the "Decision" category.
    fireEvent.click(screen.getByRole('button', { name: /Decision/ }));

    // The baseline was frozen at open time, so neither the background prop
    // change nor the unrelated interaction should have marked the draft
    // dirty.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });
});
