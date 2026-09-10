import { useCallback, useState } from "react"
import {
  CheckIcon,
  ChevronsUpDownIcon,
  CircleSlashIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import type { TrackerCampaign } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The feed is ~250 rows and identical for every user and every instance of
 * this select, so the *promise* is cached rather than the result: two selects
 * mounted at once share one request, and reopening the popover costs nothing.
 * A rejection drops the cache so Retry genuinely retries.
 */
let trackerCampaignsPromise: Promise<TrackerCampaign[]> | null = null

function loadTrackerCampaigns(): Promise<TrackerCampaign[]> {
  trackerCampaignsPromise ??= api
    .get<TrackerCampaign[]>("/tracker/campaigns")
    .catch((caught: unknown) => {
      trackerCampaignsPromise = null
      throw caught
    })
  return trackerCampaignsPromise
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; campaigns: TrackerCampaign[] }
  | { status: "error"; message: string }

const NO_CAMPAIGNS: readonly TrackerCampaign[] = []

/** Widths vary so the loading list does not read as a barcode. */
const SKELETON_WIDTHS = [
  "w-[148px]",
  "w-[104px]",
  "w-[178px]",
  "w-[126px]",
  "w-[160px]",
]

/**
 * Some feed names carry stray whitespace (" Ikkis", "AJIO ORM (internal
 * assessment) "). Trim for display and for matching; a name that trims away to
 * nothing falls back to the id so no row renders as a blank line.
 */
function displayName(campaign: TrackerCampaign): string {
  return campaign.name.trim() || campaign.id
}

/** Enough of a uuid to tell two identically-named campaigns apart. */
function shortId(id: string): string {
  return id.slice(0, 8)
}

interface TrackerCampaignSelectProps {
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
  id?: string
  /** Forwarded by `<FormControl>`, which renders as a slot around us. */
  "aria-describedby"?: string
  "aria-invalid"?: boolean
}

/**
 * Searchable single-select over the tracker's active campaigns.
 *
 * Controlled and value-only — it holds an id, never a name — so it drops
 * straight into a react-hook-form `<FormField>`.
 */
export function TrackerCampaignSelect({
  value,
  onChange,
  disabled,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: TrackerCampaignSelectProps) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<LoadState>({ status: "idle" })

  const load = useCallback(() => {
    setState({ status: "loading" })
    void loadTrackerCampaigns().then(
      (campaigns) => setState({ status: "ready", campaigns }),
      (caught: unknown) =>
        setState({ status: "error", message: errorMessage(caught) }),
    )
  }, [])

  function handleOpenChange(next: boolean) {
    setOpen(next)
    // Lazy on purpose: the campaigns page should not pay for 250 rows just to
    // render a form it may never open.
    if (next && state.status === "idle") load()
  }

  function select(nextId: string | null) {
    onChange(nextId)
    setOpen(false)
  }

  const campaigns: readonly TrackerCampaign[] =
    state.status === "ready" ? state.campaigns : NO_CAMPAIGNS
  const selected =
    value === null
      ? undefined
      : campaigns.find((campaign) => campaign.id === value)

  // Never show an empty trigger for a set value: before the list loads — and
  // for an id the tracker has since deactivated — the raw id is all we have.
  const triggerLabel =
    value === null
      ? "Select tracker campaign…"
      : selected
        ? displayName(selected)
        : value

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          disabled={disabled}
          className={cn(
            "w-full justify-between px-3 text-[13px] font-normal",
            value === null && "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "truncate",
              // A raw-id fallback reads far better monospaced than a name does.
              value !== null && !selected && "font-mono",
            )}
          >
            {triggerLabel}
          </span>
          <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-[320px] p-0"
      >
        {state.status === "error" ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <div className="flex size-8 items-center justify-center rounded-lg border bg-muted/40">
              <TriangleAlertIcon className="size-3.5 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] font-medium">
                Could not load campaigns
              </p>
              <p className="text-[12px] text-muted-foreground">
                {state.message}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              <RotateCwIcon />
              Retry
            </Button>
          </div>
        ) : (
          <Command>
            <CommandInput
              placeholder="Search tracker campaigns…"
              disabled={state.status === "loading"}
            />
            {/* 250 rows must scroll inside the popover, not stretch it. */}
            <CommandList className="max-h-[264px]">
              {state.status === "loading" && (
                <div className="p-1" aria-live="polite">
                  {SKELETON_WIDTHS.map((width) => (
                    <div
                      key={width}
                      className="flex h-8 items-center gap-2 px-2"
                    >
                      <Skeleton className={cn("h-3", width)} />
                      <Skeleton className="ml-auto h-3 w-12" />
                    </div>
                  ))}
                  <span className="sr-only">Loading tracker campaigns</span>
                </div>
              )}

              {state.status === "ready" && campaigns.length === 0 && (
                <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
                  The tracker has no active campaigns right now.
                </div>
              )}

              {state.status === "ready" && campaigns.length > 0 && (
                <>
                  <CommandEmpty>No campaign matches that search.</CommandEmpty>

                  {value !== null && (
                    <>
                      <CommandGroup>
                        <CommandItem
                          // Deliberately free of the words "tracker" and
                          // "campaign": they appear in most searches, and this
                          // row should not sit on top of every result list.
                          value="clear selection none"
                          onSelect={() => select(null)}
                          className="text-muted-foreground"
                        >
                          <CircleSlashIcon className="size-3.5" />
                          Clear selection
                        </CommandItem>
                      </CommandGroup>
                      <CommandSeparator />
                    </>
                  )}

                  <CommandGroup>
                    {campaigns.map((campaign) => {
                      const name = displayName(campaign)
                      return (
                        <CommandItem
                          // The id is the only real key: names repeat.
                          key={campaign.id}
                          // Both halves sit in the search value, so typing
                          // either a name or an id finds the row — and because
                          // the id is unique, cmdk keeps two same-named
                          // campaigns as separate, selectable entries instead
                          // of collapsing them into one.
                          value={`${name} ${campaign.id}`}
                          onSelect={() => select(campaign.id)}
                        >
                          <CheckIcon
                            className={cn(
                              "size-3.5",
                              campaign.id === value ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="truncate">{name}</span>
                          <span className="numeric ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                            {shortId(campaign.id)}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  )
}
