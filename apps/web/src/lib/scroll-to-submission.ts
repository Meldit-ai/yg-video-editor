/**
 * The DOM id a submission card carries, so a "duplicate of X" line can reach
 * the card for X.
 *
 * Not the raw id: an id starting with a digit is not a valid CSS selector, and
 * a prefix also keeps these from colliding with anything else on the page.
 */
export function submissionAnchorId(submissionId: string): string {
  return `submission-${submissionId}`
}

/**
 * How long the highlight stays on once the card has stopped moving.
 *
 * Measured from the end of the scroll rather than the click: a smooth scroll
 * across a long page can take most of a second, and starting the clock at the
 * click spent that time fading before the reader had arrived.
 */
const HIGHLIGHT_MS = 5000

/** Give up waiting for the scroll and start the clock anyway. */
const SCROLL_SETTLE_TIMEOUT_MS = 1200

/** Timers for the card currently highlighted, so a second jump can cancel them. */
let pending: { node: HTMLElement; timers: number[] } | null = null

/**
 * Asks the list holding a submission to render it, for a card that is in the
 * list but below the last page rendered so far.
 *
 * Registered by the list itself: this file knows how to reach a card, not how
 * far down anything has been paged. Answers whether the submission is in the
 * list at all, which is the same question a missing DOM node used to answer on
 * its own — before paging, "not rendered" and "not in the list" were the same
 * thing, and they no longer are.
 */
let revealer: ((submissionId: string) => boolean) | null = null

export function setSubmissionRevealer(
  reveal: ((submissionId: string) => boolean) | null,
): void {
  revealer = reveal
}

/**
 * How long to keep watching for a revealed card before giving up.
 *
 * Generous because a reveal can mean several round trips: the card may be
 * pages down a list that is read from the server a page at a time. Bounded
 * because a jump that lands a minute later is worse than one that quietly
 * does nothing.
 */
const REVEAL_TIMEOUT_MS = 10_000

function clearPending(): void {
  if (pending === null) return
  for (const timer of pending.timers) window.clearTimeout(timer)
  delete pending.node.dataset.highlighted
  pending = null
}

/**
 * Scrolls to a submission card and holds a highlight on it.
 *
 * Naming the parent was never the hard part — finding it in a grid of forty
 * cards was. The highlight is what answers "which one", so it has to outlast
 * the scroll that gets there.
 *
 * Returns false when the card is not on the page: an editor's list holds only
 * their own videos, and a filter can hide a parent too, so the caller can say
 * why nothing happened rather than leaving a click that does nothing.
 */
export function scrollToSubmission(submissionId: string): boolean {
  const node = document.getElementById(submissionAnchorId(submissionId))
  if (node === null) {
    // Not rendered. Either it is not in this list at all, or the list has not
    // paged down to it yet — only the list can tell the two apart.
    if (revealer?.(submissionId) !== true) return false
    waitForCard(submissionId, Date.now() + REVEAL_TIMEOUT_MS)
    return true
  }

  // A second jump while one is still lit: drop the first rather than letting
  // its timer clear the highlight off the new card.
  clearPending()

  node.scrollIntoView({ behavior: "smooth", block: "center" })
  // A data attribute rather than a class, so the styling stays in the card's
  // own className and this file needs to know nothing about how it looks.
  node.dataset.highlighted = "true"

  const timers: number[] = []
  const startFadeTimer = (): void => {
    timers.push(
      window.setTimeout(() => {
        delete node.dataset.highlighted
        pending = null
      }, HIGHLIGHT_MS),
    )
  }

  // `scrollend` fires when the smooth scroll actually finishes, which is the
  // moment the reader can see the card. Where it is unsupported, or the scroll
  // never fires it because the card was already in view, the timeout below
  // starts the clock instead.
  let started = false
  const onSettled = (): void => {
    if (started) return
    started = true
    document.removeEventListener("scrollend", onSettled)
    startFadeTimer()
  }
  document.addEventListener("scrollend", onSettled, { once: true })
  timers.push(window.setTimeout(onSettled, SCROLL_SETTLE_TIMEOUT_MS))

  pending = { node, timers }
  return true
}

/**
 * Retries the jump once the revealed card has been rendered.
 *
 * A reveal is a state change in the list — and often a request for the page
 * the card is on — so the card does not exist in the tick the click did.
 * Polling rather than waiting a fixed delay keeps the jump immediate on a
 * fast render and still arrives after a slow round trip; the deadline leaves
 * the reader where they are instead of scrolling somewhere unrelated later.
 */
function waitForCard(submissionId: string, deadline: number): void {
  if (document.getElementById(submissionAnchorId(submissionId)) !== null) {
    scrollToSubmission(submissionId)
    return
  }
  if (Date.now() >= deadline) return
  requestAnimationFrame(() => waitForCard(submissionId, deadline))
}
