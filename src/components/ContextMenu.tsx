import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { ContextMenuState, ContextAction } from '@/hooks/useContextMenu';

interface ContextMenuItem {
  id: string;
  label?: string;
  shortcut?: string;
  separator?: boolean;
}

interface Props {
  menu: ContextMenuState;
  items: readonly ContextMenuItem[];
  onAction: (action: ContextAction) => void;
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
            if ('separator' in item && item.separator) {
              return <div key={item.id || `sep-${i}`} className="h-px bg-white/8 my-1 mx-3" />;
            }
            return (
              <button
                key={item.id}
                onClick={() => onAction(item.id as ContextAction)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs text-white/70 hover:text-white hover:bg-white/8 transition-colors"
              >
                <span className="font-medium">{item.label}</span>
                {item.shortcut && (
                  <span className="text-[10px] text-white/20 font-mono ml-6">{item.shortcut}</span>
                )}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
