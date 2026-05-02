import { useRef, useEffect, useState } from 'react';

/**
 * Only triggers state update when dimensions actually change.
 */
export function useContainerSize(): {
  containerRef: React.RefObject<HTMLDivElement>;
  containerSize: { width: number; height: number };
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      setContainerSize(prev =>
        (prev.width === rect.width && prev.height === rect.height)
          ? prev
          : { width: rect.width, height: rect.height }
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return { containerRef, containerSize };
}
