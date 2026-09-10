import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  className?: string
}

/**
 * Shared empty / error framing. An empty table should still look composed —
 * a bare "no results" line reads like a bug.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/40">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mx-auto max-w-sm text-[13px] text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}
