import { useEffect, useState } from "react"

/** What a local video file can tell us before it is uploaded. */
export interface VideoPreview {
  /** An object URL for a still from the video, or null if none could be drawn. */
  posterUrl: string | null
  /** Seconds, or null when the browser could not read the metadata. */
  durationSeconds: number | null
  /** True while the browser is still reading the file. */
  isReading: boolean
}

/** Where in the video to grab the still, as a fraction of its length. */
const POSTER_AT = 0.1

/** Give up if the browser cannot decode the file in this long. */
const TIMEOUT_MS = 8000

/**
 * Reads a still and a duration from a video file the user just chose.
 *
 * Everything happens in the browser — the file is not uploaded to find this
 * out, and nothing is sent anywhere. An editor picking the wrong cut from a
 * folder of near-identical names finds out now rather than after waiting for a
 * 2 GB upload to finish.
 *
 * Both values are best-effort. A container the browser cannot decode (mkv and
 * m2ts are in our accept list and are commonly unsupported) yields nulls, and
 * the caller falls back to the file name — which is what it showed before.
 *
 * The still is taken a tenth of the way in rather than at zero: videos
 * routinely open on black, and a black thumbnail tells the editor nothing.
 */
export function useVideoPreview(file: File | null): VideoPreview {
  const [preview, setPreview] = useState<VideoPreview>({
    posterUrl: null,
    durationSeconds: null,
    isReading: false,
  })

  useEffect(() => {
    if (file === null) {
      setPreview({ posterUrl: null, durationSeconds: null, isReading: false })
      return
    }

    let cancelled = false
    // Held so the cleanup can revoke them: an object URL pins the whole file
    // in memory until it is released, and these are gigabytes.
    let fileUrl: string | null = null
    let posterUrl: string | null = null
    setPreview({ posterUrl: null, durationSeconds: null, isReading: true })

    const video = document.createElement("video")
    video.preload = "metadata"
    video.muted = true
    // Required for the canvas draw below: a cross-origin frame would taint the
    // canvas. An object URL is same-origin, but browsers still want this set.
    video.crossOrigin = "anonymous"

    const finish = (result: Omit<VideoPreview, "isReading">): void => {
      if (cancelled) return
      posterUrl = result.posterUrl
      setPreview({ ...result, isReading: false })
    }

    const giveUp = (): void =>
      finish({ posterUrl: null, durationSeconds: null })

    const timer = window.setTimeout(giveUp, TIMEOUT_MS)

    video.addEventListener("error", giveUp, { once: true })

    video.addEventListener(
      "loadedmetadata",
      () => {
        if (cancelled) return
        const duration = Number.isFinite(video.duration) ? video.duration : null
        // Seek before drawing; the frame at time zero is often black.
        video.currentTime = duration === null ? 0 : duration * POSTER_AT

        video.addEventListener(
          "seeked",
          () => {
            if (cancelled) return
            window.clearTimeout(timer)
            const canvas = document.createElement("canvas")
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
            const context = canvas.getContext("2d")
            if (context === null || canvas.width === 0) {
              finish({ posterUrl: null, durationSeconds: duration })
              return
            }
            context.drawImage(video, 0, 0, canvas.width, canvas.height)
            canvas.toBlob(
              (blob) => {
                if (blob === null) {
                  finish({ posterUrl: null, durationSeconds: duration })
                  return
                }
                const url = URL.createObjectURL(blob)
                // Unmounting between the blob arriving and this line would
                // otherwise leak the URL: `finish` is what hands it to the
                // cleanup, and it does nothing once cancelled.
                if (cancelled) {
                  URL.revokeObjectURL(url)
                  return
                }
                finish({ posterUrl: url, durationSeconds: duration })
              },
              "image/jpeg",
              0.7,
            )
          },
          { once: true },
        )
      },
      { once: true },
    )

    fileUrl = URL.createObjectURL(file)
    video.src = fileUrl

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      // Stop the decode and let go of the file.
      video.removeAttribute("src")
      video.load()
      if (fileUrl !== null) URL.revokeObjectURL(fileUrl)
      if (posterUrl !== null) URL.revokeObjectURL(posterUrl)
    }
  }, [file])

  return preview
}

/** 95 -> "1:35". Null stays null: an unknown duration is not zero. */
export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const whole = Math.round(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${String(rest).padStart(2, "0")}`
}
