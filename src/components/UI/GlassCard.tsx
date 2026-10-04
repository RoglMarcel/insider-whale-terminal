import { forwardRef, type HTMLAttributes } from 'react';

interface GlassCardProps extends HTMLAttributes<HTMLDivElement> {
  hover?: boolean;
}

/** Base frosted-glass surface used across the app. */
export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ hover = false, className = '', children, ...rest }, ref) => (
    <div
      ref={ref}
      className={`glass-card ${hover ? 'glass-card-hover cursor-pointer' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  ),
);

GlassCard.displayName = 'GlassCard';
