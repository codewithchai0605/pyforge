import { h } from 'xtags';
import { icon } from './icons';

export type ToastKind = 'info' | 'success' | 'error';

let host: HTMLElement | null = null;

/** A brief, non-blocking message at the bottom of the screen. */
export function toast(message: string, kind: ToastKind = 'info', ms = 2600): void {
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = h(
    'div',
    { class: `toast toast-${kind}` },
    icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check' : 'info', 18),
    h('span', null, message),
  ) as HTMLElement;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const remove = (): void => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  setTimeout(remove, kind === 'error' ? Math.max(ms, 4500) : ms);
}
