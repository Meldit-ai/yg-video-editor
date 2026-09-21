import { cn } from "@/lib/utils"
import type {
  CampaignStatus,
  ComparisonVerdict,
  Role,
  Uniqueness,
} from "@/lib/types"

/**
 * A small filled dot. Colour carries the state, so the label beside it stays
 * plain text and the row keeps its typographic rhythm.
 */
function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", className)}
    />
  )
}

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap"

export function CampaignStatusBadge({
  status,
  className,
}: {
  status: CampaignStatus
  className?: string
}) {
  const isActive = status === "ACTIVE"
  return (
    <span
      className={cn(
        PILL,
        isActive
          ? "border-success/25 bg-success/10 text-success"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={isActive ? "bg-success" : "bg-muted-foreground"} />
      {isActive ? "Active" : "Paused"}
    </span>
  )
}

export function RoleBadge({
  role,
  className,
}: {
  role: Role
  className?: string
}) {
  const isAdmin = role === "ADMIN"
  return (
    <span
      className={cn(
        PILL,
        isAdmin
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={isAdmin ? "bg-primary" : "bg-muted-foreground"} />
      {isAdmin ? "Admin" : "Editor"}
    </span>
  )
}

/**
 * How each verdict band is worded and coloured.
 *
 * Deliberately not a red/green pass-fail: only MATCH is stated as fact.
 * The engine's own middle bands mean "a person should look", and dressing
 * them up as duplicates would get editors accused on a 62.
 */
const VERDICT: Record<
  ComparisonVerdict,
  { label: string; short: string; pill: string; dot: string }
> = {
  MATCH: {
    label: "Duplicate",
    short: "Duplicate",
    pill: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  LIKELY_MATCH: {
    label: "Likely duplicate",
    short: "Likely",
    pill: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
  },
  UNCERTAIN: {
    label: "Needs review",
    short: "Review",
    pill: "border-border bg-muted/50 text-foreground",
    dot: "bg-muted-foreground",
  },
  NO_MATCH: {
    label: "Unrelated",
    short: "Unrelated",
    pill: "border-border bg-muted/40 text-muted-foreground",
    dot: "bg-muted-foreground",
  },
}

/** Result of one compared pair. `compact` drops to the one-word form. */
export function ComparisonVerdictBadge({
  verdict,
  compact = false,
  className,
}: {
  verdict: ComparisonVerdict
  compact?: boolean
  className?: string
}) {
  const style = VERDICT[verdict]
  return (
    <span className={cn(PILL, style.pill, className)}>
      <Dot className={style.dot} />
      {compact ? style.short : style.label}
    </span>
  )
}

/** The same wording, unstyled — for sentences and tooltips. */
export function verdictLabel(verdict: ComparisonVerdict): string {
  return VERDICT[verdict].label
}

/**
 * How each uniqueness label is worded and coloured.
 *
 * DUPLICATE is the only one stated as an accusation. PARTIAL means "shares
 * something with an earlier video, below the line the admin drew" — worth a
 * look, not a verdict — so it gets the warning tone rather than the red.
 */
const UNIQUENESS: Record<
  Uniqueness,
  { label: string; pill: string; dot: string }
> = {
  UNIQUE: {
    label: "Unique",
    pill: "border-success/25 bg-success/10 text-success",
    dot: "bg-success",
  },
  PARTIAL: {
    label: "Partial",
    pill: "border-warning/30 bg-warning/10 text-warning",
    dot: "bg-warning",
  },
  DUPLICATE: {
    label: "Duplicate",
    pill: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
}

/**
 * A video's label, with its match value beside it where there is one worth
 * showing. `null` is "not checked" — either still queued or unreadable; the
 * caller decides which wording it wants via `pendingLabel`.
 */
export function UniquenessBadge({
  uniqueness,
  value,
  pendingLabel = "Not checked",
  partialAs = "PARTIAL",
  className,
}: {
  uniqueness: Uniqueness | null
  /** The match value, shown as a percentage for PARTIAL and DUPLICATE. */
  value?: number | null
  pendingLabel?: string
  /**
   * What word a PARTIAL wears.
   *
   * Grouped views say two things only — this video, and the ones taken from
   * it — so a PARTIAL borrows whichever word fits its place: "Unique" when it
   * heads a group, "Duplicate" when it sits under one. A third word invites a
   * judgement the grouping already makes. Its percentage is unaffected: how
   * partial it is stays the useful part.
   */
  partialAs?: Uniqueness
  className?: string
}) {
  if (uniqueness === null) {
    return (
      <span
        className={cn(
          PILL,
          "border-border bg-muted/40 text-muted-foreground",
          className,
        )}
      >
        <Dot className="bg-muted-foreground" />
        {pendingLabel}
      </span>
    )
  }
  const shown = uniqueness === "PARTIAL" ? partialAs : uniqueness
  const style = UNIQUENESS[shown]
  // The percentage follows the real label, not the shown one: a PARTIAL
  // displayed as an original still says how partial it is.
  const showValue =
    uniqueness !== "UNIQUE" && value !== undefined && value !== null
  return (
    <span className={cn(PILL, style.pill, className)}>
      <Dot className={style.dot} />
      {style.label}
      {showValue ? (
        <span className="numeric opacity-80">· {Math.round(value)}%</span>
      ) : null}
    </span>
  )
}

/** The same wording, unstyled — for sentences and tooltips. */
export function uniquenessLabel(uniqueness: Uniqueness): string {
  return UNIQUENESS[uniqueness].label
}

/**
 * Vendor status. Unlike the badges above this is a toggle the admin controls
 * directly, and an inactive vendor stays in the list — so "Inactive" reads as
 * a state, not as a tombstone.
 */
export function ActiveBadge({
  active,
  className,
}: {
  active: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        PILL,
        active
          ? "border-success/25 bg-success/10 text-success"
          : "border-border bg-muted/50 text-muted-foreground",
        className,
      )}
    >
      <Dot className={active ? "bg-success" : "bg-muted-foreground"} />
      {active ? "Active" : "Inactive"}
    </span>
  )
}
