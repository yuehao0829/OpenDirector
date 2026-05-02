import { useCallback, useRef, useEffect, type CSSProperties } from 'react';

interface ResizerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  style?: CSSProperties;
}

export function Resizer({ direction, onResize, style }: ResizerProps) {
  const isDragging = useRef(false);
  const startPos = useRef(0);
  const onResizeRef = useRef(onResize);

  // Keep the callback ref updated
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging.current = true;
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;
      startPos.current = currentPos;
      onResizeRef.current(delta);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction]);

  const isHorizontal = direction === 'horizontal';

  return (
    <div
      style={style}
      className={`
        flex items-center justify-center shrink-0 z-10
        ${isHorizontal
          ? 'w-1 cursor-col-resize hover:w-2 bg-zinc-800 hover:bg-blue-600'
          : 'h-1 cursor-row-resize hover:h-2 bg-zinc-800 hover:bg-blue-600'
        }
        transition-all duration-100 group relative
      `}
      onMouseDown={handleMouseDown}
    >
      <div
        className={`
          absolute opacity-0 group-hover:opacity-100 transition-opacity
          ${isHorizontal
            ? 'flex flex-col gap-0.5'
            : 'flex flex-row gap-0.5'
          }
        `}
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="w-1 h-1 bg-white rounded-full"
          />
        ))}
      </div>
    </div>
  );
}
