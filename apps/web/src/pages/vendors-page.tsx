import { useEffect, useMemo, useRef, useState } from "react"
import {
  BookUserIcon,
  ExternalLinkIcon,
  FilterXIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SearchXIcon,
  TriangleAlertIcon,
  UploadIcon,
  UserRoundCheckIcon,
  UserRoundXIcon,
  XIcon,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { toast } from "sonner"

import { Kbd } from "@/components/command-palette"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { ActiveBadge } from "@/components/status-badge"
import { VendorFormDialog } from "@/components/vendor-form-dialog"
import { VendorImportDialog } from "@/components/vendor-import-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { errorMessage, useCollection } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { fullDate, shortDate } from "@/lib/format"
import { CHORD_WINDOW_MS, hasOpenOverlay, isTypingTarget } from "@/lib/keyboard"
import type { Vendor } from "@/lib/types"
import { ShareHistory } from "@/components/share-history"
import { cn } from "@/lib/utils"

type VendorFilter = "all" | "active" | "inactive"

/** The two halves of this page: who the vendors are, and what went to them. */
const VENDOR_TABS = [
  { value: "vendors", label: "Vendors" },
  { value: "sent", label: "Sent to vendors" },
] as const

type VendorTab = (typeof VENDOR_TABS)[number]["value"]

const FILTERS: readonly { value: VendorFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
]

/**
 * The filter is server-side: `active` is a real column, and letting the API
 * do it keeps the counts in the header honest about the whole directory
 * rather than about whatever happens to be loaded.
 */
function collectionPath(filter: VendorFilter): string {
  if (filter === "active") return "/vendors?active=true"
  if (filter === "inactive") return "/vendors?active=false"
  return "/vendors"
}

/** Name, phone, email, three socials, status, created, updated, id, actions. */
const COLUMN_COUNT = 11

const CELL = "px-3 py-0"
const HEAD =
  "h-8 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

const SKELETON_ROWS = [
  { name: "w-28", email: "w-36", social: "w-16" },
  { name: "w-40", email: "w-28", social: "w-20" },
  { name: "w-32", email: "w-44", social: "w-14" },
  { name: "w-24", email: "w-32", social: "w-20" },
  { name: "w-36", email: "w-24", social: "w-16" },
]

const SOCIAL_BASE = {
  instagram: "https://instagram.com/",
  twitter: "https://x.com/",
  linkedin: "https://linkedin.com/in/",
} as const

type SocialKind = keyof typeof SOCIAL_BASE

/** Digits only, so "+91 98765 43210" still matches a typed "9876". */
function digits(value: string): string {
  return value.replace(/\D/g, "")
}

/**
 * A handle becomes a profile URL; anything with a slash in it is already one
 * and is only given a scheme if it lacks one. People paste both.
 */
function socialHref(kind: SocialKind, value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes("/")) {
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  }
  return `${SOCIAL_BASE[kind]}${trimmed.replace(/^@/, "")}`
}

/** The readable part: a bare handle, or a URL's last path segment. */
function socialLabel(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.includes("/")) return trimmed.replace(/^@/, "")
  const segments = trimmed.replace(/\/+$/, "").split("/")
  return segments[segments.length - 1] ?? trimmed
}

function Blank() {
  return <span className="text-muted-foreground/50">—</span>
}

function SocialCell({
  kind,
  value,
}: {
  kind: SocialKind
  value: string | null
}) {
  if (!value || value.trim().length === 0) return <Blank />
  return (
    <a
      href={socialHref(kind, value)}
      target="_blank"
      rel="noreferrer"
      title={value}
      className="group/link inline-flex max-w-[16ch] items-center gap-1 rounded-sm text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span className="truncate">{socialLabel(value)}</span>
      <ExternalLinkIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100 group-focus-visible/link:opacity-100" />
    </a>
  )
}

function DateCell({ iso }: { iso: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={iso}
          tabIndex={0}
          className="numeric rounded-sm text-[13px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {shortDate(iso)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="top">{fullDate(iso)}</TooltipContent>
    </Tooltip>
  )
}

/** Short id, full cuid in the tooltip, whole thing on the clipboard. */
function IdCell({ id }: { id: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      toast.success("Copied")
    } catch {
      toast.error("Could not copy to the clipboard.")
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy id ${id}`}
          className="numeric rounded-sm font-mono text-[12px] text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {id.slice(0, 8)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="font-mono text-[11px]">
        {id}
      </TooltipContent>
    </Tooltip>
  )
}

export function VendorsPage() {
  const [filter, setFilter] = useState<VendorFilter>("all")
  const [tab, setTab] = useState<VendorTab>("vendors")
  const { items, isLoading, error, refetch } = useCollection<Vendor>(
    collectionPath(filter),
  )

  const [query, setQuery] = useState("")
  // null while creating; a vendor while editing.
  const [editing, setEditing] = useState<Vendor | null>(null)
  const [isFormOpen, setFormOpen] = useState(false)
  const [isImportOpen, setImportOpen] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const searchRef = useRef<HTMLInputElement>(null)
  const reduceMotion = useReducedMotion()

  // "/" jumps to the filter, "C" creates, "I" imports. The palette owns a
  // `g v` chord for navigating here, so a key arriving just after a `g`
  // belongs to that chord rather than to this page.
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
      if (key === "/") {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (key !== "c" && key !== "i") return
      if (Date.now() - lastChordKeyRef.current < CHORD_WINDOW_MS) {
        lastChordKeyRef.current = 0
        return
      }

      event.preventDefault()
      if (key === "c") {
        setEditing(null)
        setFormOpen(true)
      } else {
        setImportOpen(true)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const activeCount = useMemo(
    () => items.filter((vendor) => vendor.active).length,
    [items],
  )

  // Client-side only: the page already has the rows, and the server has no
  // search parameter.
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return items
    const termDigits = digits(term)
    return items.filter((vendor) => {
      const haystack = [
        vendor.name,
        vendor.email,
        vendor.instagram,
        vendor.twitter,
        vendor.linkedin,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .toLowerCase()
      return (
        haystack.includes(term) ||
        (termDigits.length > 0 &&
          digits(vendor.phoneNumber).includes(termDigits))
      )
    })
  }, [items, query])

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(vendor: Vendor) {
    setEditing(vendor)
    setFormOpen(true)
  }

  /**
   * Flip a vendor's status.
   *
   * Never optimistic: under the Active or Inactive filter the row leaves the
   * list entirely, and what the list looks like afterwards is the server's
   * answer, not one we can guess. `undoable` is false for the undo itself, so
   * the chain of toasts ends after one step.
   */
  async function setActive(vendor: Vendor, active: boolean, undoable = true) {
    setTogglingId(vendor.id)
    try {
      await api.patch<Vendor>(`/vendors/${vendor.id}`, { active })
      await refetch()
      toast.success(
        active ? `Activated ${vendor.name}` : `Deactivated ${vendor.name}`,
        undoable
          ? {
              duration: 6000,
              action: {
                label: "Undo",
                onClick: () => void setActive(vendor, !active, false),
              },
            }
          : undefined,
      )
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setTogglingId(null)
    }
  }

  const isFiltering = query.trim().length > 0
  const filterLabel =
    FILTERS.find((option) => option.value === filter)?.label.toLowerCase() ??
    "all"
  const showTable = !isLoading && !error && visible.length > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Vendors"
        description="Contact details and socials for the vendors you work with. Not login accounts."
        meta={
          isLoading || error ? undefined : (
            <>
              <span>
                <span className="numeric text-foreground">{items.length}</span>{" "}
                {items.length === 1 ? "vendor" : "vendors"}
              </span>
              <MetaDivider />
              <span>
                <span className="numeric text-foreground">{activeCount}</span>{" "}
                active
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
          <>
            <Button
              variant="outline"
              size="sm"
              aria-keyshortcuts="i"
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon />
              Import
              <Kbd className="ml-0.5 hidden sm:inline-flex">I</Kbd>
            </Button>
            <Button size="sm" aria-keyshortcuts="c" onClick={openCreate}>
              <PlusIcon />
              New vendor
              <Kbd className="ml-0.5 hidden border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground/85 sm:inline-flex">
                C
              </Kbd>
            </Button>
          </>
        }
      />

      {/* Two things an admin does with vendors: manage who they are, and see
          what was sent to them. The second used to be three clicks inside a
          campaign, which meant knowing the answer before you could look. */}
      <div className="flex w-fit items-center gap-1 rounded-lg border bg-muted/40 p-0.5">
        {VENDOR_TABS.map((option) => {
          const isSelected = tab === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setTab(option.value)}
              className={cn(
                "relative rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                isSelected
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {isSelected && (
                <motion.span
                  aria-hidden
                  layoutId="vendors-tab"
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

      {tab === "sent" && <ShareHistory />}

      <div
        hidden={tab !== "vendors"}
        className="panel-sheen overflow-hidden rounded-lg border bg-card"
      >
        <div className="flex flex-wrap items-center gap-3 border-b px-2 py-2">
          <div className="relative w-full max-w-xs">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("")
              }}
              aria-label="Filter vendors by name, contact or handle"
              placeholder="Filter vendors…"
              className="h-8 border-transparent bg-muted/40 pr-9 pl-8 text-[13px] shadow-none transition-colors hover:bg-muted/60 dark:bg-muted/40 dark:hover:bg-muted/60 [&::-webkit-search-cancel-button]:hidden"
            />
            {isFiltering ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Clear filter"
                onClick={() => {
                  setQuery("")
                  searchRef.current?.focus()
                }}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon />
              </Button>
            ) : (
              <span
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
              >
                <Kbd>/</Kbd>
              </span>
            )}
          </div>

          <div
            role="group"
            aria-label="Filter vendors by status"
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
                      layoutId="vendor-active-filter"
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

          <div className="ml-auto flex items-center gap-2">
            {isFiltering && !isLoading && !error && (
              <p className="numeric text-[11px] text-muted-foreground">
                {visible.length} of {items.length}
              </p>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Refresh vendors"
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
        </div>

        {/* No min-width: Table's wrapper scrolls horizontally and the cells
            are nowrap, so eleven columns scroll inside the card instead of
            pushing the page sideways. */}
        <Table>
          <TableHeader className="[&_tr]:border-b">
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Name</TableHead>
              <TableHead className={HEAD}>Phone</TableHead>
              <TableHead className={HEAD}>Email</TableHead>
              <TableHead className={HEAD}>Instagram</TableHead>
              <TableHead className={HEAD}>Twitter</TableHead>
              <TableHead className={HEAD}>LinkedIn</TableHead>
              <TableHead className={HEAD}>Status</TableHead>
              <TableHead className={HEAD}>Created</TableHead>
              <TableHead className={HEAD}>Updated</TableHead>
              <TableHead className={HEAD}>ID</TableHead>
              <TableHead className={`${HEAD} w-10`}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              SKELETON_ROWS.map((widths, index) => (
                <TableRow key={index} className="hover:bg-transparent">
                  <TableCell className={`${CELL} h-11`}>
                    <Skeleton className={`h-3 ${widths.name}`} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-3 w-24" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className={`h-3 ${widths.email}`} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className={`h-3 ${widths.social}`} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className={`h-3 ${widths.social}`} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className={`h-3 ${widths.social}`} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-4 w-16 rounded-full" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-3 w-12" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-3 w-12" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-3 w-14" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="ml-auto size-4" />
                  </TableCell>
                </TableRow>
              ))}

            {!isLoading && error && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="p-0 whitespace-normal"
                >
                  <EmptyState
                    icon={TriangleAlertIcon}
                    title="Couldn't load vendors"
                    description={error}
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void refetch()}
                      >
                        Try again
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {!isLoading && !error && items.length === 0 && filter === "all" && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="p-0 whitespace-normal"
                >
                  <EmptyState
                    icon={BookUserIcon}
                    title="No vendors yet"
                    description="Add one by hand, or download the template and import a whole list."
                    action={
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setImportOpen(true)}
                        >
                          <UploadIcon />
                          Import vendors
                        </Button>
                        <Button size="sm" onClick={openCreate}>
                          <PlusIcon />
                          New vendor
                        </Button>
                      </div>
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {!isLoading && !error && items.length === 0 && filter !== "all" && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="p-0 whitespace-normal"
                >
                  <EmptyState
                    icon={FilterXIcon}
                    title={`No ${filterLabel} vendors`}
                    description="Nothing in the directory has that status right now."
                    action={
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setFilter("all")}
                      >
                        Show all vendors
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {!isLoading &&
              !error &&
              items.length > 0 &&
              visible.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={COLUMN_COUNT}
                    className="p-0 whitespace-normal"
                  >
                    <EmptyState
                      icon={SearchXIcon}
                      title="No matching vendors"
                      description={`Nothing here matches “${query.trim()}”. Try a name, number, email or handle.`}
                      action={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setQuery("")
                            searchRef.current?.focus()
                          }}
                        >
                          Clear filter
                        </Button>
                      }
                    />
                  </TableCell>
                </TableRow>
              )}

            {showTable &&
              visible.map((vendor) => (
                <TableRow key={vendor.id} className="group/row">
                  <TableCell className={`${CELL} h-11`}>
                    <span
                      title={vendor.name}
                      className={cn(
                        "block max-w-[24ch] truncate text-[13px] font-medium",
                        !vendor.active && "text-muted-foreground",
                      )}
                    >
                      {vendor.name}
                    </span>
                  </TableCell>

                  <TableCell className={CELL}>
                    <span className="numeric font-mono text-[12px] text-muted-foreground">
                      {vendor.phoneNumber}
                    </span>
                  </TableCell>

                  <TableCell className={CELL}>
                    {vendor.email ? (
                      <span
                        title={vendor.email}
                        className="block max-w-[28ch] truncate text-[13px] text-muted-foreground"
                      >
                        {vendor.email}
                      </span>
                    ) : (
                      <Blank />
                    )}
                  </TableCell>

                  <TableCell className={CELL}>
                    <SocialCell kind="instagram" value={vendor.instagram} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <SocialCell kind="twitter" value={vendor.twitter} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <SocialCell kind="linkedin" value={vendor.linkedin} />
                  </TableCell>

                  <TableCell className={CELL}>
                    <ActiveBadge active={vendor.active} />
                  </TableCell>

                  <TableCell className={CELL}>
                    <DateCell iso={vendor.createdAt} />
                  </TableCell>
                  <TableCell className={CELL}>
                    <DateCell iso={vendor.updatedAt} />
                  </TableCell>

                  <TableCell className={CELL}>
                    <IdCell id={vendor.id} />
                  </TableCell>

                  <TableCell className={`${CELL} text-right`}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${vendor.name}`}
                          className="size-7 text-muted-foreground/70 transition-colors group-hover/row:text-foreground data-[state=open]:text-foreground"
                        >
                          <MoreHorizontalIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onSelect={() => openEdit(vendor)}>
                          <PencilIcon />
                          Edit details
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {/* Not destructive: deactivating hides nothing and
                            loses nothing, and it is undone from the same menu. */}
                        <DropdownMenuItem
                          disabled={togglingId === vendor.id}
                          onSelect={() =>
                            void setActive(vendor, !vendor.active)
                          }
                        >
                          {vendor.active ? (
                            <>
                              <UserRoundXIcon />
                              Deactivate
                            </>
                          ) : (
                            <>
                              <UserRoundCheckIcon />
                              Activate
                            </>
                          )}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      <VendorFormDialog
        open={isFormOpen}
        onOpenChange={setFormOpen}
        vendor={editing}
        onSaved={refetch}
      />

      <VendorImportDialog
        open={isImportOpen}
        onOpenChange={setImportOpen}
        onImported={refetch}
      />
    </div>
  )
}
