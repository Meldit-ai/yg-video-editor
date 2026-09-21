import { format, formatDistanceToNowStrict, isThisYear, isValid } from "date-fns"

/**
 * "2h ago", "3d ago" — for the most recent activity, where recency matters
 * more than the exact instant.
 */
export function relativeTime(iso: string): string {
  const date = new Date(iso)
  if (!isValid(date)) return "—"
  return formatDistanceToNowStrict(date, { addSuffix: true })
}

/**
 * "9 Sep" within the current year, "9 Sep 2025" outside it. Dropping the
 * redundant year keeps dense table columns narrow.
 */
export function shortDate(iso: string): string {
  const date = new Date(iso)
  if (!isValid(date)) return "—"
  return format(date, isThisYear(date) ? "d MMM" : "d MMM yyyy")
}

/** Full timestamp, for tooltips over an abbreviated date. */
export function fullDate(iso: string): string {
  const date = new Date(iso)
  if (!isValid(date)) return "Unknown date"
  return format(date, "d MMMM yyyy 'at' HH:mm")
}

/**
 * "₹1,500", "₹1,750.50" — a rate in rupees. Paise appear only when the
 * amount actually has them, so a column of whole-rupee rates stays quiet.
 */
export function rupees(amount: number): string {
  if (!Number.isFinite(amount)) return "—"
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

/** "AB" from "Aditi Bose", "A" from "Aditi" — avatar fallback text. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  const first = parts[0]?.[0] ?? ""
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : ""
  return (first + last).toUpperCase()
}

/**
 * "340 KB", "1.2 MB", "1.4 GB" — the size of a file someone just picked, where
 * an exact byte count would be noise. Video submissions run to gigabytes, so
 * the scale does not stop at MB.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`
}

/**
 * 12400 -> 12.4K, 5139611 -> 5.1M.
 *
 * View counts are read at a glance and compared against each other, so the
 * magnitude matters far more than the last four digits.
 */
export function compact(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}
