interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-8',
};

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <span
      className={`inline-block rounded-full border-2 border-transparent border-t-accent ${sizeClasses[size]} ${className}`}
      style={{ animation: 'sam-spin 0.6s linear infinite' }}
      role="status"
      aria-label="Loading"
    />
  );
}
