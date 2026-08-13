import { describe, expect, it } from 'vitest';

import { createProjectionIndex, flowSlice, structureSlice } from '../src/client/projections';
import type { ViewerModel } from '../src/server/payloads';

describe('viewer projection index', () => {
  it('resolves deep reverse-ordered hierarchies without repeated full-model scans', () => {
    const depth = 10_000;
    const elements = Array.from({ length: depth }, (_, offset) => {
      const index = depth - offset - 1;
      return {
        id: `element-${index}`,
        kind: 'component' as const,
        parent: index === 0 ? undefined : `element-${index - 1}`,
        title: `Element ${index}`,
      };
    });
    const model = makeProjectionModel(elements, `element-${depth - 1}`);

    const index = createProjectionIndex(model);
    const structure = structureSlice(model, `element-${depth - 1}`, index);
    const flows = flowSlice(model, 'element-0', index);

    expect(index.elementsById.size).toBe(depth);
    expect(structure.breadcrumbs).toHaveLength(model.limits.breadcrumbs);
    expect(structure.omittedBreadcrumbs).toBe(depth - model.limits.breadcrumbs);
    expect(structure.breadcrumbs[0]?.id).toBe('element-0');
    expect(structure.breadcrumbs.at(-1)?.id).toBe(`element-${depth - 1}`);
    expect(flows.flows.map((flow) => flow.id)).toEqual(['deep-flow']);
  });
});

function makeProjectionModel(
  elements: ViewerModel['workspace']['elements'],
  deepestElement: string
): ViewerModel {
  return {
    diagnostics: [],
    interaction: {
      maxZoom: 1.5,
      minZoom: 0.75,
      mobileBreakpointPx: 760,
      panPixels: 48,
      zoomStep: 0.125,
    },
    limits: {
      breadcrumbs: 7,
      children: 80,
      flowSteps: 50,
      flows: 30,
      relationships: 120,
      stateMachines: 30,
      states: 50,
      transitions: 80,
    },
    summary: {
      counts: {
        elements: elements.length,
        flows: 1,
        relationships: 0,
        stateMachines: 0,
        unresolvedThreads: 0,
        views: 0,
      },
      name: 'Deep projection',
      roots: [elements.at(-1)!],
      truncated: { roots: 0 },
    },
    workspace: {
      elements,
      flows: [
        {
          id: 'deep-flow',
          title: 'Deep flow',
          steps: [{ id: 'deep-step', title: 'Deep step', element: deepestElement }],
        },
      ],
      name: 'Deep projection',
      relationships: [],
      stateMachines: [],
      threads: [],
    },
  };
}
