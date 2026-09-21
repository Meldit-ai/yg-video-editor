import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent, DragEvent } from "react"
import {
  DownloadIcon,
  FileVideoIcon,
  FilmIcon,
  Loader2Icon,
  RotateCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
  PencilIcon,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { useSearchParams } from "react-router-dom"
import { useAuth } from "@/auth/auth-context"
import {
  CampaignComparison,
  SubmissionCheckStrip,
  SubmissionResultDialog,
} from "@/components/campaign-comparison"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider } from "@/components/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { errorMessage, useCollection } from "@/hooks/use-collection"
import { useComparison } from "@/hooks/use-comparison"
import type { SubmissionCheck } from "@/hooks/use-comparison"
import { UploadCancelledError, api } from "@/lib/api"
import { fileSize, fullDate, relativeTime } from "@/lib/format"
import type { ComparisonPair, VideoSubmission } from "@/lib/types"
import { cn } from "@/lib/utils"

/* Mirrors apps/api/src/submissions/submissions.constants.ts. Checking here
   only saves a doomed upload — the server's checks are the real ones. */
const MAX_VIDEO_BYTES = 2_147_483_647
const MAX_SIZE_LABEL = "2 GB"
const ACCEPTED_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "mpg",
  "mpeg",
  "m2ts",
  "mts",
  "wmv",
]
/** What a browser sends when it does not recognise the container. */
const UNTYPED_MIME = ["", "application/octet-stream", "binary/octet-stream"]

/** Same rule as the API: MIME first, extension only for untyped files. */
function looksLikeVideo(file: File): boolean {
  const mime = file.type.trim().toLowerCase()
  if (mime.startsWith("video/")) return true
  if (!UNTYPED_MIME.includes(mime)) return false
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]?.toLowerCase()
  return extension !== undefined && ACCEPTED_EXTENSIONS.includes(extension)
}

/**
 * An upload in flight.
 *
 * `sending` and `finishing` are separate on purpose. When the last byte
 * reaches the API the browser is done, but the API is still pushing the tail
 * of the file into object storage — on a big video that is a real pause, and a
 * bar frozen at 100% with no label reads as a hang.
 */
type UploadState =
  | { phase: "sending"; file: File; fraction: number }
  | { phase: "finishing"; file: File }

const SECTION_LABEL =
  "text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

/** Rounded down, so "100%" only ever means the last byte is out. */
function percent(fraction: number): number {
  return Math.min(99, Math.floor(fraction * 100))
}

interface CampaignSubmissionsProps {
  campaignId: string
}

/**
 * The filter bar's options. `null` is "everything" rather than a missing
 * value, and "unchecked" is a word because a URL has to carry it.
 */
const SUBMISSION_FILTERS = [
  { label: "All", value: null },
  { label: "Unique", value: "UNIQUE" },
  { label: "Duplicate", value: "DUPLICATE" },
  { label: "Not checked", value: "unchecked" },
] as const

/**
 * The submission panel on the campaign page: hand in a cut, watch it upload,
 * play it back.
 *
 * Who sees what is the API's decision, not this component's — an editor's list
 * comes back holding only their own uploads, an admin's holds everyone's. The
 * only role-dependent thing here is wording.
 *
 * Uploads go through the API rather than straight to the bucket from the
 * browser. A presigned PUT would save a hop, but it would mean opening the
 * bucket's CORS policy — and that bucket is shared with other services, so the
 * upload takes the extra hop instead. Nothing is buffered on the way: the API
 * streams the request body into storage as it arrives.
 */
export function CampaignSubmissions({ campaignId }: CampaignSubmissionsProps) {
  const { user } = useAuth()
  // ?uniqueness=UNIQUE|PARTIAL|DUPLICATE|unchecked, so a count on the
  // dashboard can open exactly the videos it stands for.
  const [searchParams, setSearchParams] = useSearchParams()
  const uniqueness = searchParams.get("uniqueness")
  const { items, isLoading, error, refetch } = useCollection<VideoSubmission>(
    uniqueness === null
      ? `/campaigns/${campaignId}/submissions`
      : `/campaigns/${campaignId}/submissions?uniqueness=${encodeURIComponent(uniqueness)}`,
  )
  // Both roles, but not the same payload: the API redacts an editor's copy
  // down to the verdicts on their own videos, with the counterpart
  // unidentified. The full matrix panel below stays admin-only.
  const comparison = useComparison(campaignId, user !== null)
  // Owned here rather than in the panel, which is not rendered for editors.
  // `openPair` is the admin panel's per-pair view; `openResult` is the
  // per-video result a card's status strip opens.
  const [openPair, setOpenPair] = useState<ComparisonPair | null>(null)
  const [openResult, setOpenResult] = useState<VideoSubmission | null>(null)

  // "Duplicate of <which video>": the parent is looked up in this list. An
  // editor's list holds only their own videos, so a parent that belongs to
  // someone else resolves to nothing and is named as "another submission" —
  // the same line the API draws.
  const byId = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  )
  const parentOf = useCallback(
    (submission: VideoSubmission): VideoSubmission | null =>
      submission.topMatchSubmissionId === null
        ? null
        : (byId.get(submission.topMatchSubmissionId) ?? null),
    [byId],
  )

  const [upload, setUpload] = useState<UploadState | null>(null)
  const [isDragging, setDragging] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<VideoSubmission | null>(
    null,
  )
  const [isDeleting, setDeleting] = useState(false)

  // Videos the browser refused to decode, by the URL that failed. State, not a
  // ref: the card has to re-render to say so.
  const [unplayable, setUnplayable] = useState<ReadonlySet<string>>(new Set())

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Playback URLs already retried once. Keyed by URL, not by submission id, so
  // a page left open long enough to expire twice recovers both times — while a
  // video failing for any other reason still cannot refetch in a loop.
  const refreshed = useRef(new Set<string>())
  // The URL each submission is currently playing from. Every response signs a
  // fresh one, so without this a refetch after an upload or a delete would
  // change the `src` of every card and restart a video someone is watching.
  const playing = useRef(new Map<string, { url: string; expiresAt: number }>())
  const reduceMotion = useReducedMotion()

  // The XHR outlives this component: unmounting drops the only handle to
  // abortRef, leaving an upload with nothing to show it and no way to stop it.
  useEffect(() => () => abortRef.current?.abort(), [])

  const isAdmin = user?.role === "ADMIN"
  const isUploading = upload !== null

  async function send(file: File) {
    if (!looksLikeVideo(file)) {
      toast.error(`“${file.name}” is not a video file.`)
      return
    }
    if (file.size > MAX_VIDEO_BYTES) {
      toast.error(
        `“${file.name}” is ${fileSize(file.size)}. The limit is ${MAX_SIZE_LABEL}.`,
      )
      return
    }
    if (file.size === 0) {
      toast.error(`“${file.name}” is empty.`)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setUpload({ phase: "sending", file, fraction: 0 })

    const body = new FormData()
    body.append("file", file)

    try {
      await api.upload<VideoSubmission>(
        `/campaigns/${campaignId}/submissions`,
        body,
        {
          signal: controller.signal,
          onProgress: (fraction) => {
            setUpload((current) => {
              // Ignore progress for an upload that has already been replaced
              // or cancelled — a late event must not resurrect the bar.
              if (current?.phase !== "sending" || current.file !== file) {
                return current
              }
              // The last byte is out of the browser, but the API is still
              // pushing the tail of the file into storage. Say so, rather than
              // sitting at 100% looking hung.
              return fraction >= 1
                ? { phase: "finishing", file }
                : { phase: "sending", file, fraction }
            })
          },
        },
      )
      // Refetch rather than append: the row comes back with a freshly signed
      // playback URL and the server's own idea of the file name and size.
      await refetch()
      // The API starts the duplicate check *after* answering this request, so
      // there is no id to wait for — only a window in which one appears.
      comparison.watchForNewRun()
      toast.success(`Submitted ${file.name}`)
    } catch (caught) {
      if (caught instanceof UploadCancelledError) {
        toast.message("Upload cancelled")
        // A cancel can land after the API has already read the last byte and
        // written the row, so ask the server what it actually kept rather than
        // assuming nothing was.
        await refetch()
      } else {
        toast.error(errorMessage(caught))
      }
    } finally {
      abortRef.current = null
      setUpload(null)
    }
  }

  function choose(picked: File | undefined) {
    if (!picked) return
    void send(picked)
  }

  function onPicked(event: ChangeEvent<HTMLInputElement>) {
    choose(event.target.files?.[0])
    // Cleared so picking the same file twice in a row still fires a change.
    event.target.value = ""
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (isUploading) return
    choose(event.dataTransfer.files[0])
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await api.delete<VideoSubmission>(
        `/campaigns/${campaignId}/submissions/${pendingDelete.id}`,
      )
      toast.success(`Removed ${pendingDelete.fileName}`)
      setPendingDelete(null)
      await refetch()
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setDeleting(false)
    }
  }

  /**
   * The URL a card plays from, held steady until it actually expires. The
   * server signs a new one on every response, and swapping `src` mid-playback
   * would reload the player and lose the viewer's position.
   */
  function playbackSrc(submission: VideoSubmission): string {
    const current = playing.current.get(submission.id)
    if (current && current.expiresAt > Date.now()) return current.url
    playing.current.set(submission.id, {
      url: submission.playbackUrl,
      expiresAt: Date.parse(submission.playbackExpiresAt),
    })
    return submission.playbackUrl
  }

  /**
   * A <video> that gave up. Two different things look identical from here: a
   * signature that has expired, which one refetch fixes, and a container this
   * browser cannot decode, which nothing fixes — so say so instead of leaving
   * a dead black rectangle.
   */
  const handlePlaybackError = useCallback(
    (expiresAt: string, src: string) => {
      if (Date.parse(expiresAt) > Date.now()) {
        setUnplayable((current) =>
          current.has(src) ? current : new Set(current).add(src),
        )
        return
      }
      // Expired. Worth one silent refetch — but only one, so a URL that keeps
      // failing cannot spin.
      if (refreshed.current.has(src)) return
      refreshed.current.add(src)
      void refetch()
    },
    [refetch],
  )

  const uploadButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={isUploading}
      onClick={() => inputRef.current?.click()}
    >
      <UploadIcon />
      Upload video
    </Button>
  )

  return (
    <section
      onDragOver={(event) => {
        event.preventDefault()
        if (!isUploading) setDragging(true)
      }}
      onDragLeave={(event) => {
        // Only the boundary counts: moving between children fires dragleave
        // constantly and would strobe the highlight.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false)
        }
      }}
      onDrop={onDrop}
      className={cn(
        "panel-sheen space-y-3 rounded-lg border bg-card p-4 transition-colors",
        isDragging && "border-primary/60 bg-primary/5",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className={SECTION_LABEL}>Submissions</p>
          {items.length > 0 && (
            <span className="numeric text-[11px] text-muted-foreground">
              {items.length}
            </span>
          )}
        </div>
        {(items.length > 0 || isUploading) && uploadButton}
      </div>

      {/* A real control, not just a readout: the reader can narrow the list
          here as well as arrive already narrowed from the dashboard. */}
      {(items.length > 0 || uniqueness !== null) && (
        <div className="flex flex-wrap items-center gap-1 rounded-md border p-0.5">
          {SUBMISSION_FILTERS.map((option) => {
            const isActive = (uniqueness ?? null) === option.value
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams)
                  if (option.value === null) next.delete("uniqueness")
                  else next.set("uniqueness", option.value)
                  setSearchParams(next, { replace: true })
                }}
                className={cn(
                  "rounded px-2.5 py-1 text-[12px] transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            )
          })}
          {uniqueness !== null && (
            <span className="numeric ml-auto pr-2 text-[12px] text-muted-foreground">
              {items.length} shown
            </span>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        // The extensions are named alongside the wildcard because "video/*"
        // hides exactly the containers the untyped path exists for: macOS and
        // Windows do not map .mkv or .m2ts to a video MIME type, so the picker
        // would grey out the files the server is happy to accept.
        accept={[
          "video/*",
          ...ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`),
        ].join(",")}
        className="hidden"
        onChange={onPicked}
      />

      <AnimatePresence initial={false}>
        {upload && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <UploadRow
              upload={upload}
              onCancel={() => abortRef.current?.abort()}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Only the first load blanks the panel: a refetch after an upload or a
          delete must not tear down a video that is playing. */}
      {isLoading && items.length === 0 ? (
        <SubmissionsSkeleton />
      ) : error ? (
        <EmptyState
          icon={TriangleAlertIcon}
          title="Could not load submissions"
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RotateCwIcon />
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        !isUploading && (
          <EmptyState
            icon={FilmIcon}
            title="No videos submitted yet"
            description={
              isAdmin
                ? `Editors upload their cuts here. Drag a file in or use the button — up to ${MAX_SIZE_LABEL}.`
                : `Drag your cut in, or use the button. MP4, MOV or WebM, up to ${MAX_SIZE_LABEL}.`
            }
            action={uploadButton}
            className="py-10"
          />
        )
      ) : (
        <ul className="space-y-3">
          {items.map((submission) => {
            const src = playbackSrc(submission)
            return (
              <li key={submission.id}>
                <SubmissionCard
                  submission={submission}
                  src={src}
                  isUnplayable={unplayable.has(src)}
                  showEditor={isAdmin}
                  check={comparison.checkFor(submission, parentOf(submission))}
                  onOpenResult={() => setOpenResult(submission)}
                  onRemove={() => setPendingDelete(submission)}
                  onRenamed={() => void refetch()}
                  onPlaybackError={() =>
                    handlePlaybackError(submission.playbackExpiresAt, src)
                  }
                />
              </li>
            )
          })}
        </ul>
      )}

      {/* Below the list on purpose: the videos are what this panel is about,
          and the check is a verdict on them. Admin-only: it names every
          editor's cuts side by side, which a card's own strip never does. */}
      {isAdmin && (
        <CampaignComparison
          state={comparison}
          canRun={items.length >= 2}
          openPair={openPair}
          onOpenPair={setOpenPair}
        />
      )}

      <SubmissionResultDialog
        submission={openResult}
        check={
          openResult === null
            ? null
            : comparison.checkFor(openResult, parentOf(openResult))
        }
        state={comparison}
        onClose={() => setOpenResult(null)}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              Remove {pendingDelete?.fileName}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              It disappears from this campaign. The file itself is kept, so the
              submission can be restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={isDeleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              disabled={isDeleting}
              onClick={(event) => {
                // Keep the dialog mounted until the request settles.
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {isDeleting ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** The in-flight upload: name, bar, and the only way to stop it. */
function UploadRow({
  upload,
  onCancel,
}: {
  upload: UploadState
  onCancel: () => void
}) {
  const sending = upload.phase === "sending"
  const done = sending ? percent(upload.fraction) : 100
  const sent = sending ? upload.file.size * upload.fraction : upload.file.size

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-[13px]">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="truncate font-medium">{upload.file.name}</span>
        <span className="numeric ml-auto shrink-0 text-muted-foreground">
          {sending ? `${done}%` : "Finishing…"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-muted-foreground hover:text-foreground"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>

      {/* Indeterminate would be more honest for the finishing phase, but a bar
          that switches modes at the end reads as a glitch — it holds full. */}
      <Progress value={done} className="h-1.5" />

      <p className="numeric text-[11px] text-muted-foreground">
        {sending
          ? `${fileSize(sent)} of ${fileSize(upload.file.size)}`
          : `${fileSize(upload.file.size)} uploaded — saving to storage`}
      </p>
    </div>
  )
}

/** One submitted video: the player, then who sent it and when. */
function SubmissionCard({
  submission,
  src,
  isUnplayable,
  showEditor,
  check,
  onOpenResult,
  onRemove,
  onRenamed,
  onPlaybackError,
}: {
  submission: VideoSubmission
  src: string
  isUnplayable: boolean
  showEditor: boolean
  check: SubmissionCheck
  onOpenResult: () => void
  onRemove: () => void
  /** Called after a successful rename, so the list re-reads. */
  onRenamed: () => void
  onPlaybackError: () => void
}) {
  const [isRenaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState("")

  async function commitRename() {
    const trimmed = draftName.trim()
    setRenaming(false)
    // Nothing to do: an unchanged or emptied name is a cancel, not an error.
    if (trimmed.length === 0 || trimmed === submission.fileName) return
    try {
      await api.patch<VideoSubmission>(
        `/campaigns/${submission.campaignId}/submissions/${submission.id}`,
        { fileName: trimmed },
      )
      onRenamed()
    } catch (caught: unknown) {
      toast.error(errorMessage(caught))
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      {isUnplayable ? (
        // The file uploaded fine and is safe in storage — this browser just
        // has no decoder for the container. Saying that beats a black box.
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-muted/30 px-6 text-center">
          <FileVideoIcon className="size-4 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            This browser cannot play {submission.contentType}. The file is
            stored and can be downloaded.
          </p>
          <Button asChild variant="outline" size="sm">
            <a href={src} download={submission.fileName}>
              <DownloadIcon />
              Download
            </a>
          </Button>
        </div>
      ) : (
        /* The browser's own controls, deliberately: an editor checking a cut
           wants scrubbing, volume, fullscreen and picture-in-picture, and every
           one of those is already there. preload="metadata" fetches the header
           for the duration readout without pulling the whole file. */
        <video
          controls
          preload="metadata"
          src={src}
          onError={onPlaybackError}
          className="aspect-video w-full bg-black"
        />
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-2 text-[13px]">
        {isRenaming ? (
          <Input
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void commitRename()
              if (event.key === "Escape") setRenaming(false)
            }}
            onBlur={() => void commitRename()}
            aria-label={`Rename ${submission.fileName}`}
            className="h-7 min-w-0 flex-1 text-[13px]"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraftName(submission.fileName)
              setRenaming(true)
            }}
            title={`${submission.fileName} — click to rename`}
            className="group/name inline-flex min-w-0 items-center gap-1.5 rounded text-left font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="min-w-0 truncate">{submission.fileName}</span>
            <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100" />
          </button>
        )}
        <MetaDivider />
        <span className="numeric shrink-0 text-muted-foreground">
          {fileSize(submission.sizeBytes)}
        </span>
        {showEditor && (
          <>
            <MetaDivider />
            <span className="shrink-0 text-muted-foreground">
              {submission.editorName}
            </span>
          </>
        )}
        <MetaDivider />
        <span
          className="numeric shrink-0 text-muted-foreground"
          title={fullDate(submission.createdAt)}
        >
          {relativeTime(submission.createdAt)}
        </span>

        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove ${submission.fileName}`}
          onClick={onRemove}
          className="ml-auto size-7 text-muted-foreground hover:text-destructive"
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      {/* The verdict sits under the card's own facts, so a video and what the
          check says about it are read together rather than looked up. */}
      <SubmissionCheckStrip check={check} onOpenResult={onOpenResult} />
    </div>
  )
}

/** One card's worth of placeholder — the panel does not reflow when it lands. */
function SubmissionsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border">
        <Skeleton className="aspect-video w-full rounded-none" />
        <div className="flex items-center gap-2 border-t px-3 py-2">
          <Skeleton className="h-3 w-[160px]" />
          <Skeleton className="h-3 w-[60px]" />
        </div>
      </div>
    </div>
  )
}
