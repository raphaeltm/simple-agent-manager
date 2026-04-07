/**
 * Progress bar showing sub-task completion count on a parent task.
 * Green when some/all complete, amber when 0 complete.
 */
export function SubTaskProgressBar({
  completed,
  total,
}: {
  completed: number;
  total: number;
}) {
  const pct = total > 0 ? (completed / total) * 100 : 0;
  const color = completed > 0 ? 'var(--sam-color-success, #22c55e)' : 'var(--sam-color-warning, #f59e0b)';

  return (
    <div className="flex items-center gap-1.5" style={{ marginTop: 4 }}>
      <div
        className="flex-1 overflow-hidden"
        style={{
          height: 3,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 2,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            borderRadius: 2,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span
        className="whitespace-nowrap"
        style={{ fontSize: 10, color: 'var(--sam-color-fg-muted)' }}
      >
        {completed}/{total}
      </span>
    </div>
  );
}
