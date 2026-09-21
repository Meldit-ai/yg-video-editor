import { useEffect, useState } from "react"
import { CheckIcon, IndianRupeeIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { rupees } from "@/lib/format"
import type { CampaignRate } from "@/lib/types"

/**
 * Rate asks waiting on an admin.
 *
 * Each row states the change being asked for rather than only the new number,
 * because "2,000" means nothing without what it replaces.
 */
export function RateApprovalQueue() {
  const [rows, setRows] = useState<CampaignRate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    api
      .get<CampaignRate[]>("/rates/pending")
      .then((data) => {
        if (!cancelled) setRows(data)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function decide(rate: CampaignRate, approve: boolean) {
    setBusyId(rate.id)
    try {
      await api.patch<CampaignRate>(`/rates/${rate.id}`, {
        approve,
        adminNote: notes[rate.id]?.trim() || undefined,
      })
      // Drop it from the queue: it is no longer pending either way.
      setRows((current) =>
        current === null ? current : current.filter((row) => row.id !== rate.id),
      )
      toast.success(
        approve
          ? `${rate.editorName} now earns ${rupees(rate.amount)} on ${rate.campaignTitle}`
          : `Declined ${rate.editorName}'s ask`,
        approve
          ? undefined
          : { description: "Their previous rate still applies." },
      )
    } catch (caught: unknown) {
      toast.error(errorMessage(caught))
    } finally {
      setBusyId(null)
    }
  }

  if (error !== null) {
    return (
      <EmptyState
        icon={IndianRupeeIcon}
        title="Could not load rate requests"
        description={error}
      />
    )
  }
  if (rows === null) {
    return (
      <div className="space-y-2">
        {[0, 1].map((index) => (
          <Skeleton key={index} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={IndianRupeeIcon}
        title="No rate requests"
        description="When an editor asks to change their rate on a campaign, it appears here for approval."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((rate) => (
        <li key={rate.id}>
          <Card className="py-0">
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-[14px] font-medium">
                  {rate.editorName}
                </span>
                <span className="text-[13px] text-muted-foreground">
                  on {rate.campaignTitle}
                </span>
                <span className="numeric ml-auto text-[14px]">
                  {/* The change, not just the ask: a number on its own is
                      not enough to decide on. */}
                  {rate.previousAmount !== null && (
                    <span className="text-muted-foreground line-through">
                      {rupees(rate.previousAmount)}
                    </span>
                  )}{" "}
                  <strong className="font-semibold">
                    {rupees(rate.amount)}
                  </strong>
                </span>
              </div>

              {rate.editorNote !== null && (
                <p className="rounded-md bg-muted/40 px-3 py-2 text-[12px]">
                  &ldquo;{rate.editorNote}&rdquo;
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={notes[rate.id] ?? ""}
                  onChange={(event) =>
                    setNotes((current) => ({
                      ...current,
                      [rate.id]: event.target.value,
                    }))
                  }
                  placeholder="Note to the editor (optional)"
                  className="h-8 min-w-48 flex-1 text-[13px]"
                />
                <Button
                  size="sm"
                  className="h-8 text-[12px]"
                  disabled={busyId === rate.id}
                  onClick={() => void decide(rate, true)}
                >
                  <CheckIcon className="size-3.5" />
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-[12px]"
                  disabled={busyId === rate.id}
                  onClick={() => void decide(rate, false)}
                >
                  <XIcon className="size-3.5" />
                  Decline
                </Button>
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  )
}
