import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { KnowledgePage } from '../../../src/pages/KnowledgePage';

// ---------------------------------------------------------------------------
// Mocks — inline data to avoid hoisting issues with vi.mock
// ---------------------------------------------------------------------------

vi.mock('../../../src/lib/api', () => ({
  listKnowledgeEntities: vi.fn().mockResolvedValue({
    entities: [
      {
        id: 'ent-1', projectId: 'proj-test', name: 'Prefers TypeScript',
        entityType: 'preference', description: 'User prefers TypeScript over JavaScript',
        observationCount: 2, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'ent-2', projectId: 'proj-test', name: 'React Expert',
        entityType: 'expertise', description: 'Deep knowledge of React patterns',
        observationCount: 1, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
      },
    ],
    total: 2,
  }),
  getKnowledgeEntity: vi.fn().mockResolvedValue({
    entity: {
      id: 'ent-1', projectId: 'proj-test', name: 'Prefers TypeScript',
      entityType: 'preference', description: 'User prefers TypeScript over JavaScript',
      observationCount: 2, createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    },
    observations: [
      { id: 'obs-1', entityId: 'ent-1', content: 'Always uses TS', source: 'explicit', confidence: 0.9, createdAt: '2026-05-01T00:00:00Z' },
    ],
    relations: [],
  }),
  createKnowledgeEntity: vi.fn().mockResolvedValue({ entity: {} }),
  deleteKnowledgeEntity: vi.fn().mockResolvedValue(undefined),
  addObservation: vi.fn().mockResolvedValue(undefined),
  deleteObservation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderKnowledge(initialRoute = '/projects/proj-test/knowledge') {
  return render(
    <MemoryRouter initialEntries={[initialRoute]}>
      <Routes>
        <Route path="/projects/:id/knowledge" element={<KnowledgePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KnowledgePage', () => {
  it('renders entity list', async () => {
    renderKnowledge();
    await waitFor(() => {
      expect(screen.getByText('Prefers TypeScript')).toBeInTheDocument();
      expect(screen.getByText('React Expert')).toBeInTheDocument();
    });
  });

  describe('URL-driven entity selection', () => {
    it('loads entity detail when ?entity=<id> is in the URL', async () => {
      const { getKnowledgeEntity } = await import('../../../src/lib/api');
      renderKnowledge('/projects/proj-test/knowledge?entity=ent-1');
      await waitFor(() => {
        expect(getKnowledgeEntity).toHaveBeenCalledWith('proj-test', 'ent-1');
      });
    });

    it('does not load entity detail when no ?entity param is present', async () => {
      const { getKnowledgeEntity } = await import('../../../src/lib/api');
      vi.mocked(getKnowledgeEntity).mockClear();
      renderKnowledge();
      await waitFor(() => {
        expect(screen.getByText('Prefers TypeScript')).toBeInTheDocument();
      });
      expect(getKnowledgeEntity).not.toHaveBeenCalled();
    });

    it('clicking an entity card triggers entity detail load', async () => {
      const user = userEvent.setup();
      const { getKnowledgeEntity } = await import('../../../src/lib/api');
      vi.mocked(getKnowledgeEntity).mockClear();

      renderKnowledge();
      await waitFor(() => {
        expect(screen.getByText('Prefers TypeScript')).toBeInTheDocument();
      });

      await user.click(screen.getByText('Prefers TypeScript'));
      await waitFor(() => {
        expect(getKnowledgeEntity).toHaveBeenCalledWith('proj-test', 'ent-1');
      });
    });
  });
});
