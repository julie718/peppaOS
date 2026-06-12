// Pan and zoom hook for infinite canvas — zero dependencies, CSS transforms + native events
import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewportState } from './types';

const MIN_SCALE = 0.25;
const MAX_SCALE = 3.0;

export function useCanvasPanZoom(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [viewport, setViewport] = useState<ViewportState>({
    scale: 1,
    translateX: 0,
    translateY: 0,
  });

  const spaceDown = useRef(false);
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0, tx: 0, ty: 0 });

  const resetView = useCallback(() => {
    setViewport({ scale: 1, translateX: 0, translateY: 0 });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        spaceDown.current = true;
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        isPanning.current = false;
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setViewport(prev => {
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * zoomFactor));

        // Zoom toward cursor position
        const scaleRatio = newScale / prev.scale;
        const newTx = mouseX - (mouseX - prev.translateX) * scaleRatio;
        const newTy = mouseY - (mouseY - prev.translateY) * scaleRatio;

        return { scale: newScale, translateX: newTx, translateY: newTy };
      });
    };

    const onMouseDown = (e: MouseEvent) => {
      // Middle button or Space+Left click to pan
      if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
        e.preventDefault();
        isPanning.current = true;
        panStart.current = {
          x: e.clientX,
          y: e.clientY,
          tx: viewport.translateX,
          ty: viewport.translateY,
        };
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isPanning.current) return;
      const dx = e.clientX - panStart.current.x;
      const dy = e.clientY - panStart.current.y;
      setViewport(prev => ({
        ...prev,
        translateX: panStart.current.tx + dx,
        translateY: panStart.current.ty + dy,
      }));
    };

    const onMouseUp = () => {
      isPanning.current = false;
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [containerRef, viewport]);

  const viewportStyle: React.CSSProperties = {
    transform: `scale(${viewport.scale}) translate(${viewport.translateX}px, ${viewport.translateY}px)`,
    transformOrigin: '0 0',
  };

  return { ...viewport, viewportStyle, resetView };
}
