import { useEffect, useState } from "react"
import { IndianRupeeIcon, ClockIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { rupees } from "@/lib/format"
import type { EffectiveRate } from "@/lib/types"
import { cn } from "@/lib/utils"

/** How each source of a rate is worded to the editor. */
const SOURCE_LABEL: Record<EffectiveRate["source"], string> = {
  APPROVED_CAMPAIGN_RATE: "Agreed for you on this campaign",
  CAMPAIGN_DEFAULT: "This campaign's standard rate",
  USER_RATE_CARD: "Your usual rate",
  NONE: "No rate agreed yet",
}

/**
 * What the editor earns on this campaign, and where they ask to change it.
 *
 * The pending ask is shown next to the rate that is actually paying, never
 * instead of it: an editor who asked for more should be able to see at a
 * glance that the old rate is still what they are owed.
 */
export function CampaignRateCard({ campaignId }: { campaignId: string }) {
  const [rate, setRate] = useState<EffectiveRate | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [isEditing, setEditing] = useState(false)
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [isSaving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .get<EffectiveRate>(`/rates/campaigns/${campaignId}/effective`)
      .then((data) => {
        if (!cancelled) setRate(data)
      })
      .catch(() => {
        // A missing rate is not worth an error banner on the campaign page.
        if (!cancelled) setRate(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [campaignId])

  async function submit() {
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Enter a rate in rupees.")
      return
    }
    setSaving(true)
    try {
      const updated = await api.post<EffectiveRate["pending"]>(
        `/rates/campaigns/${campaignId}`,
        { amount: parsed, editorNote: note.trim() || undefined },
      )
      setRate((current) =>
        current === null ? current : { ...current, pending: updated },
      )
      setEditing(false)
      setNote("")
      toast.success("Sent for approval", {
        description: "Your current rate keeps applying until an admin agrees.",
      })
    } catch (caught: unknown) {
      toast.error(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  if (isLoading || rate === null) return null

  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <IndianRupeeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Your rate here
            </p>
            <p className="numeric text-xl leading-tight font-semibold">
              {rate.effective === null
                ? "—"
                : `${rupees(rate.effective)} per video`}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {SOURCE_LABEL[rate.source]}
            </p>
          </div>
          {!isEditing && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 text-[12px]"
              onClick={() => {
                setAmount(
                  rate.pending?.amount?.toString() ??
                    rate.effective?.toString() ??
                    "",
                )
                setEditing(true)
              }}
            >
              {rate.pending === null ? "Ask to change" : "Change your ask"}
            </Button>
          )}
        </div>

        {/* Beside the paying rate, never in place of it. */}
        {rate.pending !== null && !isEditing && (
          <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-[12px]">
            <ClockIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p>
                You asked for{" "}
                <strong className="numeric font-medium">
                  {rupees(rate.pending.amount)}
                </strong>
                . Waiting for an admin.
              </p>
              {rate.pending.editorNote !== null && (
                <p className="mt-0.5 text-muted-foreground">
                  &ldquo;{rate.pending.editorNote}&rdquo;
                </p>
              )}
            </div>
          </div>
        )}

        {isEditing && (
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-muted-foreground">₹</span>
              <Input
                autoFocus
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="Rate per video"
                className={cn("h-8 max-w-40 text-[13px]")}
              />
            </div>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why (optional) — the admin sees this"
              rows={2}
              className="text-[13px]"
            />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 text-[12px]"
                disabled={isSaving}
                onClick={() => void submit()}
              >
                {isSaving ? "Sending…" : "Send for approval"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-[12px]"
                disabled={isSaving}
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
            <p className="text-[12px] text-muted-foreground">
              Your current rate keeps applying until an admin agrees.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
