import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ContextMenuState, ContextMenuItem } from '@/hooks/useContextMenu';

interface Props {
  menu: ContextMenuState;
  items: readonly ContextMenuItem[];
  onAction: (action: string) => void;
}

export const ContextMenu: React.FC<Props> = ({ menu, items, onAction }) => {
  return (
    <AnimatePresence>
      {menu.visible && (
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="fixed z-[9999] min-w-[180px] py-1.5 rounded-xl bg-black/85 backdrop-blur-2xl border border-white/10 shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
        >
          {items.map((item, i) => {
            if (item.separator) {
              return <div key={item.id || `sep-${i}`} className="h-px bg-white/8 my-1 mx-3" />;
            }
            return (
              <button
                key={item.id}
                onClick={() => onAction(item.id)}
                className={`w-full flex items-center justify-between px-4 py-2 text-xs transition-colors ${
                  item.danger
                    ? 'text-red-300/70 hover:text-red-300 hover:bg-red-500/10'
                    : 'text-white/70 hover:text-white hover:bg-white/8'
                }`}
              >
                <span className="font-medium">{item.label}</span>
                {item.shortcut && (
                  <span className="text-xs text-white/45 font-mono ml-6">{item.shortcut}</span>
                )}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
