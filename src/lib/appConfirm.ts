export interface AppConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  tone?: 'default' | 'danger';
}

export function appConfirm(options: string | AppConfirmOptions): Promise<boolean> {
  const config: AppConfirmOptions = typeof options === 'string' ? { message: options } : options;

  if (typeof document === 'undefined') {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm';

    const panel = document.createElement('div');
    panel.className = 'w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-950/95 p-5 shadow-2xl shadow-black/40';

    const title = document.createElement('div');
    title.className = 'text-base font-semibold text-white';
    title.textContent = config.title || 'Confirm';

    const message = document.createElement('div');
    message.className = 'mt-2 whitespace-pre-wrap text-sm leading-6 text-white/65';
    message.textContent = config.message;

    const actions = document.createElement('div');
    actions.className = 'mt-5 flex justify-end gap-2';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/65 transition-colors hover:bg-white/[0.08] hover:text-white';
    cancel.textContent = config.cancelText || 'Cancel';

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = config.tone === 'danger'
      ? 'rounded-xl border border-red-400/20 bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30'
      : 'rounded-xl border border-cyan-400/20 bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/30';
    confirm.textContent = config.confirmText || 'Confirm';

    let settled = false;
    const cleanup = (value: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cleanup(false);
      if (event.key === 'Enter') cleanup(true);
    };

    cancel.addEventListener('click', () => cleanup(false));
    confirm.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });
    document.addEventListener('keydown', onKeyDown);

    actions.append(cancel, confirm);
    panel.append(title, message, actions);
    overlay.append(panel);
    document.body.append(overlay);
    confirm.focus();
  });
}
