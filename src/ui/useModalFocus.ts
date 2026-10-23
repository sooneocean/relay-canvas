import { useEffect, useRef, type RefObject } from 'react';

const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function canFocus(element: HTMLElement): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.hidden) return false;
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

export default function useModalFocus<T extends HTMLElement = HTMLElement>(): RefObject<T | null> {
  const dialogRef = useRef<T | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const originalTabIndex = dialog.getAttribute('tabindex');
    let addedFallbackTabIndex = false;

    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(canFocus);
    const focusInitial = () => {
      const closeButton = dialog.querySelector<HTMLElement>('[data-modal-close]');
      const target = closeButton && canFocus(closeButton) ? closeButton : getFocusable()[0];
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      if (!dialog.hasAttribute('tabindex')) {
        dialog.setAttribute('tabindex', '-1');
        addedFallbackTabIndex = true;
      }
      dialog.focus({ preventScroll: true });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        focusInitial();
        return;
      }
      const current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (!current || !dialog.contains(current)) {
        event.preventDefault();
        focusInitial();
        return;
      }
      const index = focusable.indexOf(current);
      if (event.shiftKey && (index <= 0 || index === -1)) {
        event.preventDefault();
        focusable[focusable.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) {
        event.preventDefault();
        focusable[0].focus({ preventScroll: true });
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      focusInitial();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    focusInitial();
    const frame = window.requestAnimationFrame(focusInitial);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      if (addedFallbackTabIndex) {
        if (originalTabIndex === null) dialog.removeAttribute('tabindex');
        else dialog.setAttribute('tabindex', originalTabIndex);
      }
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  return dialogRef;
}
