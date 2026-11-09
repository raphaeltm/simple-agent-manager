import { Button } from '@simple-agent-manager/ui';
import { ArrowRight, Loader2 } from 'lucide-react';

export function ActionButton({
  onClick,
  loading,
  disabled,
  label,
}: {
  onClick: () => void;
  loading: boolean;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Button variant="primary" size="md" onClick={onClick} disabled={loading || disabled}>
      {loading ? (
        <>
          <Loader2 size={14} className="animate-spin" /> Setting up...
        </>
      ) : (
        <>
          {label} <ArrowRight size={14} />
        </>
      )}
    </Button>
  );
}
