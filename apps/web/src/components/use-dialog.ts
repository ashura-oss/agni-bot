/**
 * What every overlay owes the keyboard: focus moves in when it opens, Tab stays
 * inside it, Escape closes it (and only it, even when it sits on top of another
 * overlay such as Settings), and focus goes back to what opened it.
 */
import { useEffect, useRef, type RefObject } from "react";

/** Open dialogs, innermost last. Only the innermost answers the keyboard. */
const stack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute("hidden"));
}

export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const token = Symbol("dialog");
    stack.push(token);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.contains(document.activeElement)) {
      if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
      (focusables(root)[0] ?? root).focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        // Keep the window-level shortcuts (which close Settings) from also seeing this key.
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const at = stack.indexOf(token);
      if (at >= 0) stack.splice(at, 1);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref]);
}
