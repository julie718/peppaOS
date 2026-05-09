import { useState, useEffect, useCallback } from 'react';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
}

const ITEMS = [
  { id: 'reload', label: 'Reload', shortcut: 'Ctrl+R' },
  { id: 'devtools', label: 'Developer Tools', shortcut: 'F12' },
  { id: 'separator1', separator: true },
  { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X' },
  { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C' },
  { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V' },
  { id: 'selectAll', label: 'Select All', shortcut: 'Ctrl+A' },
  { id: 'separator2', separator: true },
  { id: 'fullscreen', label: 'Toggle Fullscreen', shortcut: 'F11' },
] as const;

export type ContextAction = (typeof ITEMS)[number]['id'];

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0 });

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      // Position the menu, clamping to viewport edges
      const x = Math.min(e.clientX, window.innerWidth - 200);
      const y = Math.min(e.clientY, window.innerHeight - ITEMS.length * 36 - 8);
      setMenu({ visible: true, x, y });
    };

    const close = () => setMenu(prev => prev.visible ? { ...prev, visible: false } : prev);

    document.addEventListener('contextmenu', handler);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);

    return () => {
      document.removeEventListener('contextmenu', handler);
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
    };
  }, []);

  const execute = useCallback((action: ContextAction) => {
    setMenu({ visible: false, x: 0, y: 0 });
    switch (action) {
      case 'reload':
        window.location.reload();
        break;
      case 'devtools':
        // In Tauri WebView2, this might be intercepted; fallback is console hint
        console.log('[LumiOS] DevTools: Use Ctrl+Shift+I or right-click → Inspect in dev mode');
        break;
      case 'cut':
        document.execCommand('cut');
        break;
      case 'copy':
        document.execCommand('copy');
        break;
      case 'paste':
        document.execCommand('paste');
        break;
      case 'selectAll':
        document.execCommand('selectAll');
        break;
      case 'fullscreen':
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        break;
    }
  }, []);

  return { menu, items: ITEMS, execute };
}
