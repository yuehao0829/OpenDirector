import { ReactNode, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';
import { acquireNativePreviewOcclusion } from '@opendirector/core/utils/native-preview-occlusion';

let openModalCount = 0;

/** Returns true when any Modal is currently open. */
export function isAnyModalOpen(): boolean {
  return openModalCount > 0;
}

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** Modal width variant */
  size?: 'sm' | 'md' | 'lg';
}

export function Modal({ isOpen, onClose, title, children, className, size = 'md' }: ModalProps) {
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (!isOpen) return;

    const releaseOcclusion = acquireNativePreviewOcclusion('modal');
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };

    openModalCount++;
    if (openModalCount === 1) {
      document.body.style.overflow = 'hidden';
    }
    document.addEventListener('keydown', handleEscape);

    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) {
        document.body.style.overflow = '';
      }
      document.removeEventListener('keydown', handleEscape);
      releaseOcclusion();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onMouseDown={onClose} />

      <div
        className={twMerge(
          clsx(
            'relative z-10 bg-zinc-900 rounded-xl shadow-2xl',
            'border border-zinc-700 w-full mx-4',
            size === 'sm' && 'max-w-sm',
            size === 'md' && 'max-w-lg',
            size === 'lg' && 'max-w-3xl',
            className
          )
        )}
        data-testid="modal-content"
      >
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-700">
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-white transition-colors"
              data-testid="modal-close"
            >
              <X size={20} />
            </button>
          </div>
        )}

        <div className={size === 'lg' ? '' : 'p-6'}>{children}</div>
      </div>
    </div>,
    document.body
  );
}
