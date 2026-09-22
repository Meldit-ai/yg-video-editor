import { useEffect, useRef, useState } from "react"
import type { RefObject } from "react"

/**
 * Whether an element has come near the viewport yet.
 *
 * For holding back a `<video>` until it is worth fetching. Even
 * `preload="metadata"` costs one request per player, so a page of fifty
 * matches or five thousand reels opens a request storm on mount and the
 * videos someone is actually looking at queue behind the ones they are not.
 *
 * Stays true once seen: scrolling back past a video the reader already opened
 * should not tear it down and fetch it again.
 *
 * `rootMargin` starts the fetch roughly a screen early, so scrolling at a
 * normal speed finds each video ready rather than blank.
 */
export function useNearViewport<T extends HTMLElement>(): [
  RefObject<T | null>,
  boolean,
] {
  const ref = useRef<T>(null)
  const [isNear, setNear] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (node === null || isNear) return
    // Without IntersectionObserver everything loads at once, which is the
    // behaviour this replaces rather than a regression.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true)
          observer.disconnect()
        }
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [isNear])

  return [ref, isNear]
}
