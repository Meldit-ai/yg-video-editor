import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  description?: string
  /** Counts, filters — sits under the title in a quiet row. */
  meta?: ReactNode
  /** Primary action, right-aligned. */
  action?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
  meta,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 pb-1",
        className,
      )}
    >
      <div className="space-y-1">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
        {meta && (
          <div className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
            {meta}
          </div>
        )}
      </div>
      {action && <div className="flex items-center gap-2">{action}</div>}
    </div>
  )
}

/** Dot separator for stat strips: "12 active · 3 paused". */
export function MetaDivider() {
  return <span aria-hidden className="text-border">·</span>
}
