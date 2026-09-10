/**
 * Guards every global keyboard shortcut needs.
 *
 * Page-level shortcuts and the command palette have to agree on when a bare
 * keypress is fair game, otherwise "c" opens a dialog while someone is halfway
 * through typing a filter. Kept here so there is one answer, not four copies.
 */

/** How long a `g` prefix stays armed before the chord is abandoned. */
export const CHORD_WINDOW_MS = 1200

/** Typing somewhere real: global shortcuts must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

/**
 * A dialog, menu or select already owns the keyboard: do not stack a palette
 * on top of it, and do not let a bare chord fire while a menu is running its
 * own typeahead.
 */
export function hasOpenOverlay(): boolean {
  return (
    document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
    ) !== null
  )
}
