// Canvas viewport — pannable/zoomable container with grid background
import React, { useRef, useMemo } from 'react';
import { useCanvasPanZoom } from './useCanvasPanZoom';
import { computeLayout } from './canvasLayout';
import { CanvasCard as CanvasCardComponent } from './CanvasCard';
import { CanvasCard as CanvasCardType } from './types';

interface CanvasViewportProps {
  cards: CanvasCardType[];
  children?: React.ReactNode;
}

export function CanvasViewport({ cards }: CanvasViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scale, viewportStyle, resetView } = useCanvasPanZoom(containerRef);

  const positioned = useMemo(() => {
    const viewportWidth = containerRef.current?.clientWidth || 1200;
    return computeLayout(cards, viewportWidth / scale);
  }, [cards, scale]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden cursor-grab active:cursor-grabbing"
      style={{
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
        `,
        backgroundSize: `${40 * scale}px ${40 * scale}px`,
      }}
    >
      {/* Zoom controls */}
      <div className="absolute bottom-24 right-6 z-30 flex items-center gap-1 bg-black/60 backdrop-blur-xl rounded-xl border border-white/[0.08] p-1">
        <button
          onClick={() => {
            // Zoom out handled by manual dispatch
            containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
          }}
          className="w-8 h-8 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-lg text-sm transition-colors"
        >
          −
        </button>
        <span className="text-xs text-white/50 min-w-[40px] text-center tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => {
            containerRef.current?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
          }}
          className="w-8 h-8 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 rounded-lg text-sm transition-colors"
        >
          +
        </button>
        <div className="w-px h-5 bg-white/[0.08] mx-0.5" />
        <button
          onClick={resetView}
          className="px-2 h-8 flex items-center justify-center text-white/50 hover:text-white hover:bg-white/10 rounded-lg text-[10px] transition-colors"
        >
          Reset
        </button>
      </div>

      {/* Transformed canvas layer */}
      <div
        className="absolute inset-0"
        style={{
          ...viewportStyle,
          minWidth: '4000px',
          minHeight: '4000px',
        }}
      >
        {positioned.map(card => (
          <CanvasCardComponent key={card.id} card={card} />
        ))}
      </div>

      {/* Empty state */}
      {cards.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <div className="text-5xl mb-4 opacity-20">∞</div>
            <p className="text-white/30 text-sm">Describe your task below to begin</p>
          </div>
        </div>
      )}
    </div>
  );
}
