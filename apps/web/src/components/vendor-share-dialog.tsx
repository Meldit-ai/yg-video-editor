import { useEffect, useState } from "react"
import {
  CheckCircle2Icon,
  Loader2Icon,
  SendIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import {
  MAX_SHARE_MEDIA,
  MAX_SHARE_VENDORS,
  type ShareableVendor,
  type VendorShare,
  type VendorShareRecipient,
} from "@/lib/types"
import { cn } from "@/lib/utils"

interface VendorShareDialogProps {
  campaignId: string
  campaignTitle: string
  /** The videos the admin picked in the feed. */
  submissionIds: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after a successful send, so the feed can clear its selection. */
  onSent: () => void
}

/**
 * Compose a message, pick vendors, send.
 *
 * The result is shown per vendor rather than as one toast: a share can
 * partially succeed — one vendor's number is unusable, another's send is
 * refused — and "sent" over the top of that would be a lie.
 */
export function VendorShareDialog({
  campaignId,
  campaignTitle,
  submissionIds,
  open,
  onOpenChange,
  onSent,
}: VendorShareDialogProps) {
  const [vendors, setVendors] = useState<ShareableVendor[] | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState("")
  const [isSending, setSending] = useState(false)
  const [result, setResult] = useState<VendorShare | null>(null)
  /**
   * The videos as they were when the dialog opened.
   *
   * Snapshotted rather than read live: a successful send clears the feed's
   * selection, and reading through to it would empty this mid-dialog — so a
   * second send from the same dialog would post no videos at all.
   */
  const [shared, setShared] = useState<readonly string[]>([])

  // Reset per opening: a stale result from last time would read as this
  // share's outcome. Keyed on `open` alone, so nothing the send changes
  // downstream can re-run it and wipe what the admin has typed.
  useEffect(() => {
    if (!open) return
    const ids = [...submissionIds]
    setShared(ids)
    setResult(null)
    setSelected(new Set())
    setMessage(
      `Hi, please review these ${ids.length === 1 ? "video" : "videos"} for ${campaignTitle} and share your feedback.`,
    )
    let cancelled = false
    api
      .get<ShareableVendor[]>("/shareable-vendors")
      .then((data) => {
        if (!cancelled) setVendors(data)
      })
      .catch((caught: unknown) => {
        if (!cancelled) toast.error(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on open only
  }, [open])

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function send() {
    setSending(true)
    try {
      const share = await api.post<VendorShare>(
        `/campaigns/${campaignId}/shares`,
        {
          message,
          submissionIds: [...shared],
          vendorIds: [...selected],
        },
      )
      setResult(share)
      const failed = share.recipients.filter(
        (recipient) => recipient.status === "FAILED" || recipient.status === "UNREACHABLE",
      ).length
      if (failed === 0) {
        toast.success(
          share.recipients.length === 1
            ? "Sent to 1 vendor"
            : `Sent to ${share.recipients.length} vendors`,
        )
        onSent()
      } else {
        toast.warning(`${failed} of ${share.recipients.length} could not be sent`)
      }
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setSending(false)
    }
  }

  const reachableSelected = [...selected].filter(
    (id) => vendors?.find((vendor) => vendor.id === id)?.reachable ?? false,
  ).length

  // Checked here as well as on the server so the admin is told before writing
  // a message, not after sending one. The server stays the authority.
  const tooManyVideos = shared.length > MAX_SHARE_MEDIA
  const tooManyVendors = reachableSelected > MAX_SHARE_VENDORS
  const overLimit = tooManyVideos || tooManyVendors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {result === null ? "Send to vendors" : "Sent"}
          </DialogTitle>
          <DialogDescription className="text-[13px]">
            {result === null
              ? `${shared.length} ${shared.length === 1 ? "video" : "videos"} from ${campaignTitle}. Links are added to your message automatically.`
              : "What happened for each vendor."}
          </DialogDescription>
        </DialogHeader>

        {result !== null ? (
          <ul className="flex flex-col gap-1.5">
            {result.recipients.map((recipient) => (
              <ResultRow key={recipient.id} recipient={recipient} />
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="share-message" className="text-[13px]">
                Message
              </Label>
              <Textarea
                id="share-message"
                rows={4}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Write the message vendors will receive"
              />
              <p className="text-[12px] text-muted-foreground">
                The video links are appended below your text.
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-[13px]">Vendors</Label>
              {vendors === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : vendors.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-[13px] text-muted-foreground">
                  No vendors in the directory yet.
                </p>
              ) : (
                <ul className="max-h-56 overflow-y-auto rounded-md border">
                  {vendors.map((vendor) => (
                    <li
                      key={vendor.id}
                      className="flex items-center gap-2.5 border-b px-3 py-2 last:border-0"
                    >
                      <Checkbox
                        id={`vendor-${vendor.id}`}
                        checked={selected.has(vendor.id)}
                        onCheckedChange={() => toggle(vendor.id)}
                        disabled={!vendor.reachable}
                      />
                      <label
                        htmlFor={`vendor-${vendor.id}`}
                        className={cn(
                          "min-w-0 flex-1 text-[13px]",
                          vendor.reachable
                            ? "cursor-pointer"
                            : "text-muted-foreground",
                        )}
                      >
                        <span className="block truncate">{vendor.name}</span>
                        <span className="numeric block text-[11px] text-muted-foreground">
                          {vendor.reachable
                            ? vendor.phoneNumber
                            : "No usable WhatsApp number"}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {overLimit && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          >
            {tooManyVideos
              ? `${shared.length} videos selected — share at most ${MAX_SHARE_MEDIA} at a time.`
              : `${reachableSelected} vendors selected — send to at most ${MAX_SHARE_VENDORS} at a time.`}
          </p>
        )}

        <DialogFooter>
          {result === null ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={isSending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void send()}
                disabled={
                  isSending ||
                  shared.length === 0 ||
                  reachableSelected === 0 ||
                  message.trim().length === 0 ||
                  overLimit
                }
              >
                {isSending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <SendIcon />
                )}
                {isSending
                  ? "Sending"
                  : shared.length === 0
                    ? "No videos selected"
                    : reachableSelected === 0
                      ? "Select vendors"
                      : `Send to ${reachableSelected}`}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultRow({ recipient }: { recipient: VendorShareRecipient }) {
  const failed =
    recipient.status === "FAILED" || recipient.status === "UNREACHABLE"
  const Icon = failed
    ? recipient.status === "UNREACHABLE"
      ? TriangleAlertIcon
      : XCircleIcon
    : CheckCircle2Icon

  return (
    <li className="flex items-start gap-2.5 rounded-md border px-3 py-2">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          failed ? "text-[var(--warning)]" : "text-[var(--success)]",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">{recipient.vendorName}</p>
        <p className="text-[12px] text-muted-foreground">
          {recipient.status === "UNREACHABLE"
            ? "No usable WhatsApp number"
            : recipient.status === "FAILED"
              ? (recipient.errorMessage ?? "Could not be sent")
              : recipient.usedTemplate
                ? "Sent using the approved template"
                : "Sent"}
        </p>
      </div>
    </li>
  )
}
