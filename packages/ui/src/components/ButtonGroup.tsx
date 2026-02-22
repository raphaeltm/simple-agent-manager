import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode, type CSSProperties } from 'react';

export interface ButtonGroupProps {
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const containerStyle: CSSProperties = {
  display: 'inline-flex',
};

export function ButtonGroup({ children, size, className }: ButtonGroupProps) {
  const items = Children.toArray(children).filter(
    (child): child is ReactElement<{ style?: CSSProperties; size?: string }> => isValidElement(child),
  );
  const count = items.length;

  return (
    <div role="group" className={className} style={containerStyle}>
      {items.map((child, index) => {
        let borderRadius: string;
        if (count === 1) {
          borderRadius = 'var(--sam-radius-sm)';
        } else if (index === 0) {
          borderRadius = 'var(--sam-radius-sm) 0 0 var(--sam-radius-sm)';
        } else if (index === count - 1) {
          borderRadius = '0 var(--sam-radius-sm) var(--sam-radius-sm) 0';
        } else {
          borderRadius = '0';
        }

        const extraStyle: CSSProperties = {
          borderRadius,
          ...(index > 0 ? { marginLeft: -1 } : {}),
        };

        return cloneElement(child, {
          ...(size ? { size } : {}),
          style: { ...(child.props.style ?? {}), ...extraStyle },
        });
      })}
    </div>
  );
}
