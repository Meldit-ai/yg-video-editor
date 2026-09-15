import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  ClapperboardIcon,
  FilterXIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { EmptyState } from "@/components/empty-state"
import { Kbd } from "@/components/command-palette"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { CampaignStatusBadge } from "@/components/status-badge"
import { TrackerCampaignSelect } from "@/components/tracker-campaign-select"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { errorMessage, useCollection } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { fullDate, relativeTime, shortDate } from "@/lib/format"
import {
  CAMPAIGN_STATUSES,
  type Campaign,
  type CampaignStatus,
} from "@/lib/types"
import { cn } from "@/lib/utils"

const campaignFormSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  briefText: z.string(),
  guidanceNote: z.string(),
  // An id picked from the tracker feed, or null for "not linked". Never "" —
  // the select deals in ids, and the server reads null as "clear this field".
  trackerCampaignId: z.string().nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
  // Plain number, not z.coerce: a schema whose input and output types differ
  // widens useForm's generic and breaks inference for every other field. The
  // field's onChange converts the input's string instead.
  duplicationThreshold: z
    .number({ message: "Enter a number between 0 and 100" })
    .min(0, "Must be between 0 and 100")
    .max(100, "Must be between 0 and 100"),
})

type CampaignFormValues = z.infer<typeof campaignFormSchema>

const BLANK_CAMPAIGN: CampaignFormValues = {
  title: "",
  briefText: "",
  guidanceNote: "",
  trackerCampaignId: null,
  status: "ACTIVE",
  // Matches the column default, so a new campaign flags what MATCH already does.
  duplicationThreshold: 90,
}

type StatusFilter = "all" | CampaignStatus

const FILTERS = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Paused" },
] as const satisfies readonly { value: StatusFilter; label: string }[]

/** The list path carries the filter, so changing it re-runs the fetch. */
function collectionPath(filter: StatusFilter): string {
  return filter === "all" ? "/campaigns" : `/campaigns?status=${filter}`
}

/**
 * Row styling lives here rather than on `<TableRow>` because the body rows are
 * `motion.tr` — they fade in as they mount, so a new campaign arrives instead
 * of blinking into place.
 */
const ROW_CLASS =
  "group cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted/60"

const HEAD_CLASS =
  "h-9 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

const CELL_CLASS = "px-3 py-2"

/** Widths differ per row so the loading state does not look like a barcode. */
const SKELETON_ROWS = [
  { title: "w-[184px]", brief: "w-[248px]" },
  { title: "w-[142px]", brief: "w-[196px]" },
  { title: "w-[210px]", brief: "w-[232px]" },
  { title: "w-[166px]", brief: "w-[170px]" },
  { title: "w-[196px]", brief: "w-[220px]" },
]

/** Global shortcuts must stay out of the way while someone is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

function hasOpenOverlay(): boolean {
  return (
    document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
    ) !== null
  )
}

/** Matches the command palette's `g`-then-key chord window. */
const CHORD_WINDOW_MS = 1200

function DetailField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      {children}
    </div>
  )
}

/**
 * The muted second line under a campaign title, and the same label in the
 * detail sheet's header. Shows the tracker's display name when we have one,
 * and falls back to the raw id — monospaced, so a uuid stays scannable — for
 * rows linked before the name was denormalised.
 */
function TrackerLine({ campaign }: { campaign: Campaign }) {
  const name = campaign.trackerCampaignName?.trim() ?? ""
  const text = name || campaign.trackerCampaignId
  if (!text) return null
  return (
    <span
      title={text}
      className={cn(
        "block max-w-[34ch] truncate text-[11px] text-muted-foreground sm:max-w-[46ch]",
        name === "" && "numeric font-mono",
      )}
    >
      {text}
    </span>
  )
}

function FormSection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </h3>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>
      {children}
    </section>
  )
}

/**
 * The ADMIN view of campaigns: the dense table, with create / edit / delete and
 * the row detail sheet. Editors get the card grid instead, so this component is
 * only ever rendered behind an admin check.
 */
export function CampaignsAdminView() {
  const [filter, setFilter] = useState<StatusFilter>("all")
  const { items, isLoading, error, refetch } = useCollection<Campaign>(
    collectionPath(filter),
  )

  const [editing, setEditing] = useState<Campaign | null>(null)
  const [isFormOpen, setFormOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<Campaign | null>(null)
  const [isDeleting, setDeleting] = useState(false)
  // The detail panel tracks an id, not a row object: after an edit refetches
  // the list, the panel keeps showing live data instead of a stale copy.
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const reduceMotion = useReducedMotion()

  const selected =
    selectedId === null
      ? null
      : (items.find((campaign) => campaign.id === selectedId) ?? null)

  // Radix keeps the panel mounted while it slides out, so it needs something
  // to render on the way: without this the sheet empties before it leaves.
  const [lastSelected, setLastSelected] = useState<Campaign | null>(null)
  useEffect(() => {
    if (selected) setLastSelected(selected)
  }, [selected])
  const sheetCampaign = selected ?? lastSelected

  const activeCount = items.filter((item) => item.status === "ACTIVE").length
  const pausedCount = items.length - activeCount
  const filterLabel =
    FILTERS.find((option) => option.value === filter)?.label ?? "All"

  const form = useForm<CampaignFormValues>({
    resolver: zodResolver(campaignFormSchema),
    defaultValues: BLANK_CAMPAIGN,
  })

  function openCreate() {
    setEditing(null)
    form.reset(BLANK_CAMPAIGN)
    setFormOpen(true)
  }

  function openEdit(campaign: Campaign) {
    setEditing(campaign)
    // The text inputs are controlled, so their nullable columns need strings.
    // The tracker select is the exception: it speaks id-or-null natively.
    form.reset({
      title: campaign.title,
      briefText: campaign.briefText ?? "",
      guidanceNote: campaign.guidanceNote ?? "",
      trackerCampaignId: campaign.trackerCampaignId,
      status: campaign.status,
      duplicationThreshold: campaign.duplicationThreshold,
    })
    setFormOpen(true)
  }

  // "C" opens the create dialog. The palette owns a `g c` chord for navigating
  // here, so a `c` that arrives just after a `g` belongs to that chord.
  const lastChordKeyRef = useRef(0)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      if (hasOpenOverlay()) return

      const key = event.key.toLowerCase()
      if (key === "g") {
        lastChordKeyRef.current = Date.now()
        return
      }
      if (key !== "c") return
      if (Date.now() - lastChordKeyRef.current < CHORD_WINDOW_MS) {
        lastChordKeyRef.current = 0
        return
      }

      event.preventDefault()
      setEditing(null)
      form.reset(BLANK_CAMPAIGN)
      setFormOpen(true)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [form])

  async function onSubmit(values: CampaignFormValues) {
    // Built field by field rather than sent whole: `trackerCampaignName` is
    // the server's to derive from the id, so it must not travel with the form.
    const payload = {
      title: values.title,
      briefText: values.briefText,
      guidanceNote: values.guidanceNote,
      trackerCampaignId: values.trackerCampaignId,
      status: values.status,
      duplicationThreshold: values.duplicationThreshold,
    }

    try {
      if (editing) {
        await api.patch<Campaign>(`/campaigns/${editing.id}`, payload)
        toast.success(`Updated ${values.title}`)
      } else {
        await api.post<Campaign>("/campaigns", payload)
        toast.success(`Created ${values.title}`)
      }
      setFormOpen(false)
      await refetch()
    } catch (caught) {
      toast.error(errorMessage(caught))
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await api.delete<Campaign>(`/campaigns/${pendingDelete.id}`)
      toast.success(`Deleted ${pendingDelete.title}`)
      const deletedId = pendingDelete.id
      setPendingDelete(null)
      // The row is gone, so the panel describing it should go with it.
      setSelectedId((current) => (current === deletedId ? null : current))
      await refetch()
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setDeleting(false)
    }
  }

  const isSubmitting = form.formState.isSubmitting
  const showEmpty = !isLoading && !error && items.length === 0
  const showRows = !isLoading && !error && items.length > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Campaigns"
        description="Briefs and guidance notes the editing team works from."
        meta={
          isLoading || error ? undefined : (
            <>
              <span>
                <span className="numeric text-foreground">{activeCount}</span>{" "}
                active
              </span>
              <MetaDivider />
              <span>
                <span className="numeric text-foreground">{pausedCount}</span>{" "}
                paused
              </span>
              {filter !== "all" && (
                <>
                  <MetaDivider />
                  <span>filtered</span>
                </>
              )}
            </>
          )
        }
        action={
          <Button size="sm" onClick={openCreate} aria-keyshortcuts="c">
            <PlusIcon />
            New campaign
            <Kbd className="ml-0.5 hidden border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground/85 sm:inline-flex">
              C
            </Kbd>
          </Button>
        }
      />

      <div className="flex items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Filter campaigns by status"
          className="inline-flex items-center rounded-lg border bg-muted/40 p-0.5"
        >
          {FILTERS.map((option) => {
            const isSelected = option.value === filter
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setFilter(option.value)}
                className={cn(
                  "relative rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isSelected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {isSelected && (
                  <motion.span
                    aria-hidden
                    layoutId="campaign-status-filter"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", stiffness: 520, damping: 42 }
                    }
                    className="absolute inset-0 rounded-md border bg-background"
                  />
                )}
                <span className="relative">{option.label}</span>
              </button>
            )
          })}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh campaigns"
              disabled={isLoading}
              onClick={() => void refetch()}
              className="text-muted-foreground hover:text-foreground"
            >
              <RotateCwIcon className={cn(isLoading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh</TooltipContent>
        </Tooltip>
      </div>

      <div className="panel-sheen overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD_CLASS}>Title</TableHead>
              <TableHead className={cn(HEAD_CLASS, "w-[116px]")}>
                Status
              </TableHead>
              <TableHead
                className={cn(HEAD_CLASS, "hidden w-[300px] lg:table-cell")}
              >
                Brief
              </TableHead>
              <TableHead
                className={cn(HEAD_CLASS, "hidden w-[108px] md:table-cell")}
              >
                Updated
              </TableHead>
              <TableHead className={cn(HEAD_CLASS, "w-[52px]")}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {isLoading &&
              SKELETON_ROWS.map((row) => (
                <TableRow key={row.title} className="hover:bg-transparent">
                  <TableCell className={CELL_CLASS}>
                    <div className="flex min-h-[34px] flex-col justify-center gap-1.5">
                      <Skeleton className={cn("h-3.5", row.title)} />
                      <Skeleton className="h-2.5 w-[72px]" />
                    </div>
                  </TableCell>
                  <TableCell className={CELL_CLASS}>
                    <Skeleton className="h-5 w-[70px] rounded-full" />
                  </TableCell>
                  <TableCell className={cn(CELL_CLASS, "hidden lg:table-cell")}>
                    <Skeleton className={cn("h-3", row.brief)} />
                  </TableCell>
                  <TableCell className={cn(CELL_CLASS, "hidden md:table-cell")}>
                    <Skeleton className="h-3 w-14" />
                  </TableCell>
                  <TableCell className={CELL_CLASS}>
                    <Skeleton className="size-6 rounded-md" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && error && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0 whitespace-normal">
                  <EmptyState
                    icon={TriangleAlertIcon}
                    title="Could not load campaigns"
                    description={error}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void refetch()}
                      >
                        <RotateCwIcon />
                        Try again
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {showEmpty && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="p-0 whitespace-normal">
                  {filter === "all" ? (
                    <EmptyState
                      icon={ClapperboardIcon}
                      title="No campaigns yet"
                      description="A campaign holds the brief, the guidance note and the tracker link — everything an editor needs before they open the timeline."
                      action={
                        <Button size="sm" onClick={openCreate}>
                          <PlusIcon />
                          New campaign
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      icon={FilterXIcon}
                      title={`No ${filterLabel.toLowerCase()} campaigns`}
                      description={`Nothing is currently ${filterLabel.toLowerCase()}. Clear the filter to see everything the team has briefed.`}
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setFilter("all")}
                        >
                          Show all campaigns
                        </Button>
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            )}

            {showRows &&
              items.map((campaign) => (
                <motion.tr
                  key={campaign.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.15,
                    ease: "easeOut",
                  }}
                  data-state={
                    selectedId === campaign.id ? "selected" : undefined
                  }
                  onClick={() => setSelectedId(campaign.id)}
                  className={ROW_CLASS}
                >
                  <TableCell className={CELL_CLASS}>
                    <div className="flex min-h-[34px] flex-col justify-center gap-0.5">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedId(campaign.id)
                        }}
                        className="max-w-[34ch] truncate rounded-sm text-left text-[13px] font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:max-w-[46ch]"
                      >
                        {campaign.title}
                      </button>
                      <TrackerLine campaign={campaign} />
                    </div>
                  </TableCell>

                  <TableCell className={CELL_CLASS}>
                    <CampaignStatusBadge status={campaign.status} />
                  </TableCell>

                  <TableCell className={cn(CELL_CLASS, "hidden lg:table-cell")}>
                    {campaign.briefText ? (
                      <span className="block max-w-[300px] truncate text-[13px] text-muted-foreground">
                        {campaign.briefText}
                      </span>
                    ) : (
                      <span className="text-[13px] text-muted-foreground/50">
                        —
                      </span>
                    )}
                  </TableCell>

                  <TableCell className={cn(CELL_CLASS, "hidden md:table-cell")}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="numeric cursor-default text-[13px] text-muted-foreground">
                          {relativeTime(campaign.updatedAt)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {fullDate(campaign.updatedAt)}
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>

                  <TableCell className={CELL_CLASS}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${campaign.title}`}
                          onClick={(event) => event.stopPropagation()}
                          className={cn(
                            // Recedes until the row is hovered, but stays put
                            // on touch screens, where no hover reveals it.
                            "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
                            "max-md:opacity-100",
                          )}
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-40"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuItem
                          onSelect={() => setSelectedId(campaign.id)}
                        >
                          <ClapperboardIcon />
                          View details
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openEdit(campaign)}>
                          <PencilIcon />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingDelete(campaign)}
                        >
                          <Trash2Icon />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </motion.tr>
              ))}
          </TableBody>
        </Table>
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 data-[state=closed]:duration-150 data-[state=open]:duration-200 sm:max-w-lg"
        >
          {sheetCampaign && (
            <>
              <SheetHeader className="gap-2 border-b p-4 pr-12">
                <div className="flex items-center gap-2">
                  <CampaignStatusBadge status={sheetCampaign.status} />
                  <TrackerLine campaign={sheetCampaign} />
                </div>
                <SheetTitle className="text-[15px] leading-snug">
                  {sheetCampaign.title}
                </SheetTitle>
                <SheetDescription className="numeric text-[12px]">
                  Created {shortDate(sheetCampaign.createdAt)} · updated{" "}
                  {relativeTime(sheetCampaign.updatedAt)}
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 space-y-5 overflow-y-auto p-4">
                <DetailField label="Tracker campaign">
                  {sheetCampaign.trackerCampaignId ? (
                    <div className="space-y-1">
                      <p className="text-[13px]">
                        {sheetCampaign.trackerCampaignName?.trim() ||
                          "Name unavailable"}
                      </p>
                      <p className="numeric font-mono text-[11px] break-all text-muted-foreground">
                        {sheetCampaign.trackerCampaignId}
                      </p>
                    </div>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      Not linked to a tracker campaign.
                    </p>
                  )}
                </DetailField>

                <DetailField label="Brief">
                  {sheetCampaign.briefText ? (
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
                      {sheetCampaign.briefText}
                    </p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      No brief written yet.
                    </p>
                  )}
                </DetailField>

                <DetailField label="Guidance note">
                  {sheetCampaign.guidanceNote ? (
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
                      {sheetCampaign.guidanceNote}
                    </p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">
                      No guidance note yet.
                    </p>
                  )}
                </DetailField>

                <div className="grid grid-cols-2 gap-4 border-t pt-4">
                  <DetailField label="Created">
                    <p className="numeric text-[13px] text-muted-foreground">
                      {fullDate(sheetCampaign.createdAt)}
                    </p>
                  </DetailField>
                  <DetailField label="Updated">
                    <p className="numeric text-[13px] text-muted-foreground">
                      {fullDate(sheetCampaign.updatedAt)}
                    </p>
                  </DetailField>
                  <div className="col-span-2">
                    <DetailField label="Record">
                      <p className="numeric font-mono text-[11px] break-all text-muted-foreground">
                        {sheetCampaign.id}
                      </p>
                    </DetailField>
                  </div>
                </div>
              </div>

              <SheetFooter className="flex-row items-center justify-between gap-2 border-t p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPendingDelete(sheetCampaign)}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2Icon />
                  Delete
                </Button>
                <Button size="sm" onClick={() => openEdit(sheetCampaign)}>
                  <PencilIcon />
                  Edit campaign
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={isFormOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {editing ? "Edit campaign" : "New campaign"}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              Only a title is required — the brief and guidance can follow once
              the shoot is locked.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              id="campaign-form"
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-6 py-1"
            >
              <FormSection label="Basics">
                <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-[13px]">Title</FormLabel>
                        <FormControl>
                          <Input placeholder="Diwali launch film" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-[13px]">Status</FormLabel>
                        <Select
                          value={field.value}
                          onValueChange={field.onChange}
                        >
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {CAMPAIGN_STATUSES.map((status) => (
                              <SelectItem key={status} value={status}>
                                {status === "ACTIVE" ? "Active" : "Paused"}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="duplicationThreshold"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px]">
                        Accepted duplication
                      </FormLabel>
                      <FormControl>
                        <div className="relative w-[180px]">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            inputMode="numeric"
                            className="numeric pr-7"
                            {...field}
                            // The input yields a string; the form holds a
                            // number. An empty box becomes NaN, which zod
                            // reports rather than silently sending 0.
                            onChange={(event) =>
                              field.onChange(
                                event.target.value === ""
                                  ? Number.NaN
                                  : event.target.valueAsNumber,
                              )
                            }
                            value={
                              Number.isNaN(field.value) ? "" : field.value
                            }
                          />
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] text-muted-foreground"
                          >
                            %
                          </span>
                        </div>
                      </FormControl>
                      <FormDescription className="text-[12px]">
                        Videos scoring at or above this are flagged as
                        duplicates. Uploads are never blocked.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FormSection>

              <FormSection label="Tracking">
                <FormField
                  control={form.control}
                  name="trackerCampaignId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px]">
                        Tracker campaign
                      </FormLabel>
                      <FormControl>
                        <TrackerCampaignSelect
                          value={field.value}
                          onChange={field.onChange}
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormDescription className="text-[12px]">
                        Search the tracker's active campaigns by name or id.
                        Optional — leave it clear if there is no match yet.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </FormSection>

              <FormSection label="Editorial">
                <div className="grid gap-4">
                  <FormField
                    control={form.control}
                    name="briefText"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-[13px]">Brief</FormLabel>
                        <FormControl>
                          <Textarea
                            rows={4}
                            placeholder="What this campaign needs to achieve, and who it is for."
                            {...field}
                          />
                        </FormControl>
                        <FormDescription className="text-[12px]">
                          Line breaks are preserved exactly as you type them.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="guidanceNote"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-[13px]">
                          Guidance note
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            rows={3}
                            placeholder="Tone, pacing, dos and don'ts."
                            {...field}
                          />
                        </FormControl>
                        <FormDescription className="text-[12px]">
                          The craft notes an editor should read before cutting.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </FormSection>
            </form>
          </Form>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFormOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              form="campaign-form"
              disabled={isSubmitting}
            >
              {isSubmitting && <Loader2Icon className="animate-spin" />}
              {editing ? "Save changes" : "Create campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              Delete {pendingDelete?.title}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              It disappears from the list, but the record is kept and can be
              restored later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {isDeleting && <Loader2Icon className="animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
