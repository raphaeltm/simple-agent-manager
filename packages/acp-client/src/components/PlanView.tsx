import React from 'react';

import type { PlanItem } from '../hooks/useAcpMessages';

interface PlanViewProps {
  plan: PlanItem;
}

/**
 * Shared plan rendering component used by both AgentPanel (workspace chat)
 * and ProjectMessageView (project chat) for display parity.
 * Uses glassmorphic design: dark glass background, green accents.
 */
export const PlanView = React.memo(function PlanView({ plan }: PlanViewProps) {
  return (
    <div
      style={{
        margin: '8px 0',
        padding: 12,
        borderRadius: 10,
        border: '1px solid rgba(34, 197, 94, 0.12)',
        backgroundColor: 'rgba(8, 15, 12, 0.45)',
      }}
    >
      <h4 style={{ fontSize: '0.75rem', fontWeight: 500, color: '#9fb7ae', textTransform: 'uppercase', marginBottom: 8, marginTop: 0 }}>Plan</h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {plan.entries.map((entry, idx) => (
          <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.875rem' }}>
            <span
              style={{
                display: 'inline-block',
                height: 8,
                width: 8,
                borderRadius: '50%',
                flexShrink: 0,
                backgroundColor:
                  entry.status === 'completed' ? '#22c55e' :
                  entry.status === 'in_progress' ? '#22c55e' : '#4a6a60',
                boxShadow: entry.status === 'in_progress' ? '0 0 6px rgba(34, 197, 94, 0.5)' : 'none',
                animation: entry.status === 'in_progress' ? 'glowPulse 2s ease-in-out infinite' : 'none',
              }}
            />
            <span
              style={{
                color: entry.status === 'completed' ? '#9fb7ae' : '#e6f2ee',
                textDecoration: entry.status === 'completed' ? 'line-through' : 'none',
                opacity: entry.status === 'completed' ? 0.7 : 1,
              }}
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
});
