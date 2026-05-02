import { ButtonHTMLAttributes, forwardRef } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={twMerge(
          clsx(
            'inline-flex items-center justify-center font-medium rounded-lg transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            {
              'bg-blue-600 text-white hover:bg-blue-700': variant === 'primary',
              'bg-zinc-700 text-white hover:bg-zinc-600': variant === 'secondary',
              'bg-transparent text-zinc-300 hover:bg-zinc-800': variant === 'ghost',
              'bg-red-600 text-white hover:bg-red-700': variant === 'danger',
            },
            {
              'px-2 py-1 text-sm': size === 'sm',
              'px-4 py-2 text-sm': size === 'md',
              'px-6 py-3 text-base': size === 'lg',
            },
            className
          )
        )}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
