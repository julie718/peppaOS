import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface GlowPosition {
  x: number;
  y: number;
}

export function CursorGlow() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<GlowPosition>({ x: 0, y: 0 });

  const handleShow = useCallback(() => setVisible(true), []);
  const handleHide = useCallback(() => setVisible(false), []);
  const handleUpdate = useCallback((e: Event) => {
    const { x, y } = (e as CustomEvent).detail as GlowPosition;
    setPos({ x, y });
  }, []);

  useEffect(() => {
    window.addEventListener('cursor-glow:show', handleShow);
    window.addEventListener('cursor-glow:hide', handleHide);
    window.addEventListener('cursor-glow:update', handleUpdate);
    return () => {
      window.removeEventListener('cursor-glow:show', handleShow);
      window.removeEventListener('cursor-glow:hide', handleHide);
      window.removeEventListener('cursor-glow:update', handleUpdate);
    };
  }, [handleShow, handleHide, handleUpdate]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="fixed pointer-events-none z-[9999]"
          style={{
            left: pos.x - 32,
            top: pos.y - 32,
            width: 64,
            height: 64,
          }}
        >
          {/* Outer glow ring */}
          <div className="absolute inset-0 rounded-full animate-pulse"
            style={{
              background: 'radial-gradient(circle, rgba(99,180,255,0.3) 0%, rgba(99,180,255,0.1) 50%, transparent 70%)',
              boxShadow: '0 0 30px rgba(99,180,255,0.5), 0 0 60px rgba(99,180,255,0.25), inset 0 0 20px rgba(99,180,255,0.2)',
            }}
          />
          {/* Inner ring */}
          <div className="absolute inset-4 rounded-full"
            style={{
              border: '2px solid rgba(99,180,255,0.7)',
              boxShadow: '0 0 10px rgba(99,180,255,0.6), inset 0 0 6px rgba(99,180,255,0.3)',
            }}
          />
          {/* Center dot */}
          <div className="absolute inset-[28px] rounded-full bg-blue-400"
            style={{ boxShadow: '0 0 12px rgba(99,180,255,0.9)' }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
