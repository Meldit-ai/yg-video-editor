import { useEffect, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
  SendIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { relativeTime, shortDate } from "@/lib/format"
import type { DeliveryCheck, VendorShareRow } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * What was sent to which vendor, and what they sent back.
 *
 * The record existed from the first share but nothing ever read it, so an
 * admin could not answer "which links did I send to whom" — let alone see a
 * reply. Both halves are here: the videos that went out with the vendors they
 * went to, and each post link that came back with what we made of it.
 */
export function ShareHistory({
  campaignId,
}: {
  /** Omit to list every campaign's shares, for the Vendors page. */
  campaignId?: string
}) {
  const [shares, setShares] = useState<VendorShareRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get<VendorShareRow[]>(
        campaignId === undefined
          ? "/shares"
          : `/campaigns/${campaignId}/shares`,
      )
      .then((data) => {
        if (!cancelled) setShares(data)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught))
      })
    return () => {
      cancelled = true
    }
  }, [campaignId])

  if (error !== null) {
    return (
      <EmptyState
        icon={SendIcon}
        title="Could not load the share history"
        description={error}
      />
    )
  }
  if (shares === null) {
    return (
      <div className="space-y-2">
        {[0, 1].map((index) => (
          <Skeleton key={index} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    )
  }
  if (shares.length === 0) {
    return (
      <EmptyState
        icon={SendIcon}
        title="Nothing shared yet"
        description="Select videos in the campaign feed and send them to vendors. Every send, and every reply, is recorded here."
      />
    )
  }

  const replies = shares.reduce((sum, share) => sum + share.replies.length, 0)

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <p className="text-[12px] text-muted-foreground">
          {shares.length === 1 ? "1 share" : `${shares.length} shares`}
          {replies > 0 &&
            ` · ${replies === 1 ? "1 reply" : `${replies} replies`}`}
        </p>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>

      <ul className="flex flex-col gap-2">
        {shares.map((share) => (
          <li key={share.id}>
            <ShareRow share={share} showCampaign={campaignId === undefined} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function ShareRow({
  share,
  showCampaign,
}: {
  share: VendorShareRow
  showCampaign: boolean
}) {
  const [isOpen, setOpen] = useState(false)
  const failed = share.recipients.filter(
    (one) => one.status === "FAILED" || one.status === "UNREACHABLE",
  ).length
  // A reply that carries one of the videos we sent — the finding this whole
  // loop exists to produce.
  const confirmed = share.replies.filter(
    (one) => one.delivery === "SAME_FILE" || one.delivery === "SAME_FOOTAGE",
  ).length

  return (
    <Card className="overflow-hidden py-0">
      <button
        type="button"
        onClick={() => setOpen((open) => !open)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {isOpen ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}

        {/* Who it went to, which is how an admin looks a share up. */}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {share.recipients.map((one) => one.vendorName).join(", ") ||
            "No recipients"}
        </span>

        {/* Which campaign, when the list is not already one campaign's. */}
        {showCampaign && (
          <span className="shrink-0 truncate text-[12px] text-muted-foreground">
            {share.campaignTitle}
          </span>
        )}

        <span className="numeric shrink-0 text-[12px] text-muted-foreground">
          {share.videos.length === 1
            ? "1 video"
            : `${share.videos.length} videos`}
        </span>

        {failed > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[11px] text-warning"
            title={`${failed} of ${share.recipients.length} did not arrive`}
          >
            <TriangleAlertIcon className="size-3" />
            {failed} failed
          </span>
        )}

        {share.replies.length > 0 && (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
              confirmed > 0
                ? "bg-success/15 text-success"
                : "bg-muted text-muted-foreground",
            )}
            title={
              confirmed > 0
                ? `${confirmed} reply(s) carry a video from this share`
                : "Replies received, none confirmed as ours"
            }
          >
            <MessageSquareIcon className="size-3" />
            {share.replies.length}
            {confirmed > 0 && ` · ${confirmed} ours`}
          </span>
        )}

        <span
          className="numeric w-16 shrink-0 text-right text-[12px] text-muted-foreground"
          title={shortDate(share.createdAt)}
        >
          {relativeTime(share.createdAt)}
        </span>
      </button>

      {isOpen && (
        <div className="space-y-3 border-t bg-muted/20 px-3 py-3">
          {/* Exactly which videos went out. `submissionIds` is a plain array so
              the record survives a withdrawal, which is why a name can be
              missing here. */}
          <div>
            <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
              Videos sent
            </p>
            <ul className="flex flex-col gap-0.5">
              {share.videos.map((video) => (
                <li
                  key={video.submissionId}
                  className="truncate text-[12px]"
                  title={video.fileName ?? undefined}
                >
                  {video.fileName ?? (
                    <span className="text-muted-foreground italic">
                      Since withdrawn from the campaign
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
              Sent to
            </p>
            <ul className="flex flex-col gap-0.5">
              {share.recipients.map((one) => (
                <li
                  key={one.id}
                  className="flex items-center gap-2 text-[12px]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {one.vendorName}
                  </span>
                  <span className="numeric shrink-0 text-muted-foreground">
                    {one.waNumber ?? "no number"}
                  </span>
                  <StatusChip status={one.status} error={one.errorMessage} />
                </li>
              ))}
            </ul>
          </div>

          {/* What the admin typed. The links themselves were appended at send
              time, so this is the note, not the whole message. */}
          {share.messageBody.trim().length > 0 && (
            <div>
              <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                Note
              </p>
              <p className="rounded-md bg-background px-2.5 py-1.5 text-[12px] whitespace-pre-wrap">
                {share.messageBody}
              </p>
            </div>
          )}

          <div>
            <p className="mb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
              Replies
            </p>
            {share.replies.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                Nothing back yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {share.replies.map((reply) => (
                  <li key={reply.id}>
                    <ReplyRow reply={reply} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

function StatusChip({
  status,
  error,
}: {
  status: VendorShareRow["recipients"][number]["status"]
  error: string | null
}) {
  const failed = status === "FAILED" || status === "UNREACHABLE"
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[11px]",
        status === "SENT" && "bg-success/15 text-success",
        failed && "bg-warning/15 text-warning",
        status === "PENDING" && "bg-muted text-muted-foreground",
      )}
      // The reason, where there is one: "FAILED" alone does not say why.
      title={error ?? undefined}
    >
      {status === "SENT" ? "sent" : status.toLowerCase()}
    </span>
  )
}

/** How each delivery verdict is worded, and how much it claims. */
const DELIVERY: Record<
  DeliveryCheck,
  { label: string; tone: "good" | "warn" | "quiet"; hint: string }
> = {
  SAME_FILE: {
    label: "Ours",
    tone: "good",
    hint: "The very same file as one of the videos sent on this share",
  },
  SAME_FOOTAGE: {
    label: "Ours",
    tone: "good",
    hint: "The same footage as a video sent on this share, re-encoded",
  },
  DIFFERENT: {
    label: "Not ours",
    tone: "warn",
    hint: "Compared, and it carries none of the videos sent on this share",
  },
  NOT_FINGERPRINTED: {
    label: "Cannot tell",
    tone: "quiet",
    // Deliberately not "not ours": nothing was compared.
    hint: "The post has no fingerprint yet, so nothing could be compared",
  },
  PENDING: {
    label: "Not checked",
    tone: "quiet",
    hint: "Not compared yet",
  },
}

/** How the reply was tied to this share, and how much to trust it. */
const MATCHED_BY: Record<string, string> = {
  REPLIED_TO_MESSAGE: "replied to our message",
  SENDER_NUMBER: "matched by their number",
  AMBIGUOUS_SENDER: "guessed from their number — they have several open shares",
  UNMATCHED: "could not be tied to a share",
}

function ReplyRow({
  reply,
}: {
  reply: VendorShareRow["replies"][number]
}) {
  const delivery = DELIVERY[reply.delivery]

  return (
    <div className="rounded-md bg-background px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {reply.vendorName ?? reply.fromNumber}
        </span>

        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[11px]",
            delivery.tone === "good" && "bg-success/15 text-success",
            delivery.tone === "warn" && "bg-warning/15 text-warning",
            delivery.tone === "quiet" && "bg-muted text-muted-foreground",
          )}
          title={delivery.hint}
        >
          {delivery.label}
          {reply.deliveredFrameShare !== null &&
            reply.delivery === "SAME_FOOTAGE" &&
            ` · ${reply.deliveredFrameShare}%`}
        </span>

        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[11px]",
            reply.onTracker === "FOUND"
              ? "bg-muted text-muted-foreground"
              : "bg-muted/60 text-muted-foreground",
          )}
          title={
            reply.onTracker === "FOUND"
              ? "The tracker already holds this post"
              : reply.onTracker === "NOT_FOUND"
                ? "Not on the tracker — not imported yet, or not this campaign's"
                : "Not looked up yet"
          }
        >
          {reply.onTracker === "FOUND" ? "on tracker" : "not on tracker"}
        </span>

        <a
          href={reply.canonicalLink}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Open the post on Instagram"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>

        <span
          className="numeric w-14 shrink-0 text-right text-[11px] text-muted-foreground"
          title={shortDate(reply.sentAt ?? reply.createdAt)}
        >
          {relativeTime(reply.sentAt ?? reply.createdAt)}
        </span>
      </div>

      {/* Which of our videos it is, when we know. */}
      {reply.deliveredFileName !== null && (
        <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-success">
          <CheckIcon className="size-3 shrink-0" />
          {reply.deliveredFileName}
        </p>
      )}

      {/* Their actual words, so a human can read what they meant. */}
      {reply.messageBody.trim().length > 0 &&
        reply.messageBody.trim() !== reply.canonicalLink && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            &ldquo;{reply.messageBody.trim()}&rdquo;
          </p>
        )}

      {/* How confidently it was tied to this share. Stated, because a guess
          and a certainty should not read the same. */}
      {reply.matchedBy !== "REPLIED_TO_MESSAGE" && (
        <p className="mt-0.5 text-[11px] text-muted-foreground italic">
          {MATCHED_BY[reply.matchedBy]}
        </p>
      )}
    </div>
  )
}
