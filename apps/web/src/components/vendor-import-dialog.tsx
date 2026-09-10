import { useEffect, useRef, useState } from "react"
import {
  CircleCheckIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  Loader2Icon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { EmptyState } from "@/components/empty-state"
import { MetaDivider } from "@/components/page-header"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { errorMessage } from "@/hooks/use-collection"
import { api } from "@/lib/api"
import { fileSize } from "@/lib/format"
import type { VendorImportResult } from "@/lib/types"
import { cn } from "@/lib/utils"

/* Mirrors apps/api/src/vendors/import/vendor-import.columns.ts. Only the
   limits travel to the browser — no spreadsheet code does. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ROWS_LABEL = "5,000"
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const TEMPLATE_FILE_NAME = "vendors-import-template.xlsx"

const STEPS = [
  "Download the template",
  "Fill it in — name and phone are required",
  "Upload it here",
]

const HEAD =
  "h-8 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
const CELL = "px-3 py-2 align-top"

function Blank() {
  return <span className="text-muted-foreground/50">—</span>
}

interface VendorImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Reload the list. Called as soon as a run finishes, not on close. */
  onImported: () => Promise<void> | void
}

/**
 * Bulk import: template out, spreadsheet in, per-row verdict back.
 *
 * `isImporting` lives out here because the dialog chrome needs it — while a
 * file is uploading there is no close button, and Escape and an outside click
 * are both inert. Everything else is state of the body, which Radix unmounts
 * on close, so a reopened dialog always starts at the picker.
 */
export function VendorImportDialog({
  open,
  onOpenChange,
  onImported,
}: VendorImportDialogProps) {
  const [isImporting, setImporting] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={!isImporting}
        onEscapeKeyDown={(event) => {
          if (isImporting) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (isImporting) event.preventDefault()
        }}
        className="max-h-[90svh] overflow-y-auto sm:max-w-2xl"
      >
        <ImportBody
          isImporting={isImporting}
          setImporting={setImporting}
          onOpenChange={onOpenChange}
          onImported={onImported}
        />
      </DialogContent>
    </Dialog>
  )
}

function ImportBody({
  isImporting,
  setImporting,
  onOpenChange,
  onImported,
}: Omit<VendorImportDialogProps, "open"> & {
  isImporting: boolean
  setImporting: (importing: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<VendorImportResult | null>(null)
  const [isDragging, setDragging] = useState(false)
  const [isDownloading, setDownloading] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLButtonElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const isFirstRender = useRef(true)

  // Focus follows the phase. Without this it would fall to <body>: the button
  // that was focused (Import, or Import another) unmounts as the phase flips.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    if (result) doneRef.current?.focus()
    else dropRef.current?.focus()
  }, [result])

  function choose(picked: File | undefined) {
    if (!picked) return
    if (!/\.xlsx$/i.test(picked.name)) {
      toast.error(`“${picked.name}” is not an .xlsx file.`)
      return
    }
    if (picked.size > MAX_FILE_BYTES) {
      toast.error(
        `That file is ${fileSize(picked.size)}. The limit is ${fileSize(MAX_FILE_BYTES)}.`,
      )
      return
    }
    setFile(picked)
  }

  async function downloadTemplate() {
    setDownloading(true)
    try {
      await api.download("/vendors/import/template", TEMPLATE_FILE_NAME)
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setDownloading(false)
    }
  }

  async function runImport() {
    if (!file) return
    setImporting(true)
    try {
      const body = new FormData()
      body.append("file", file, file.name)
      setResult(
        await api.postForm<VendorImportResult>("/vendors/import", body),
      )
      // Refresh the list behind the overlay straight away, so closing this
      // dialog needs no "did an import happen" bookkeeping.
      void onImported()
    } catch (caught) {
      // A whole-file failure leaves the picker as it was, file still chosen,
      // so a fixed sheet can be re-picked without starting over.
      toast.error(errorMessage(caught))
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-[15px]">Import vendors</DialogTitle>
        <DialogDescription className="text-[13px]">
          {result
            ? "Every row that did not become a vendor is listed below."
            : "Add a whole list at once from a spreadsheet."}
        </DialogDescription>
      </DialogHeader>

      {result ? (
        <ImportResult result={result} />
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="grid gap-2 text-[13px] sm:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step} className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="numeric mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] text-muted-foreground"
                >
                  {index + 1}
                </span>
                <span className="text-muted-foreground">{step}</span>
              </li>
            ))}
          </ol>

          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={isDownloading}
              onClick={() => void downloadTemplate()}
            >
              <DownloadIcon />
              {isDownloading ? "Preparing…" : "Download template"}
            </Button>
          </div>

          <button
            ref={dropRef}
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              choose(event.dataTransfer.files[0])
            }}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-6 py-10 text-center transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              isDragging
                ? "border-primary/60 bg-primary/5"
                : "border-border hover:bg-muted/40",
            )}
          >
            {file ? (
              <>
                <FileSpreadsheetIcon className="size-5 text-muted-foreground" />
                <span className="text-[13px] font-medium">{file.name}</span>
                <span className="text-[12px] text-muted-foreground">
                  <span className="numeric">{fileSize(file.size)}</span> · click
                  to choose another
                </span>
              </>
            ) : (
              <>
                <UploadIcon className="size-5 text-muted-foreground" />
                <span className="text-[13px] font-medium">
                  Drop your .xlsx here, or click to browse
                </span>
                <span className="text-[12px] text-muted-foreground">
                  Up to {fileSize(MAX_FILE_BYTES)} and {MAX_ROWS_LABEL} rows
                </span>
              </>
            )}
          </button>

          <input
            ref={inputRef}
            type="file"
            accept={`.xlsx,${XLSX_MIME}`}
            tabIndex={-1}
            className="sr-only"
            onChange={(event) => {
              choose(event.target.files?.[0])
              // Cleared so re-picking the same file still fires a change.
              event.target.value = ""
            }}
          />
        </div>
      )}

      {result ? (
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setResult(null)
              setFile(null)
            }}
          >
            Import another
          </Button>
          <Button ref={doneRef} size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      ) : (
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={isImporting}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!file || isImporting}
            onClick={() => void runImport()}
          >
            {isImporting ? (
              <>
                <Loader2Icon className="animate-spin" />
                Importing…
              </>
            ) : (
              "Import"
            )}
          </Button>
        </DialogFooter>
      )}
    </>
  )
}

function SummaryStat({
  count,
  label,
  dotClassName,
}: {
  count: number
  label: string
  dotClassName: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        count === 0 && "opacity-40",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", dotClassName)}
      />
      <span className="numeric font-medium">{count}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function ImportResult({ result }: { result: VendorImportResult }) {
  // Created rows need no explanation; what deserves a second look is
  // everything else. The counts above already say how many there were.
  const problems = result.rows.filter((row) => row.status !== "created")

  return (
    <div className="flex flex-col gap-3">
      <p
        role="status"
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]"
      >
        <SummaryStat
          count={result.created}
          label="created"
          dotClassName="bg-success"
        />
        <SummaryStat
          count={result.duplicates}
          label={result.duplicates === 1 ? "duplicate" : "duplicates"}
          dotClassName="bg-warning"
        />
        <SummaryStat
          count={result.errors}
          label={result.errors === 1 ? "error" : "errors"}
          dotClassName="bg-destructive"
        />
        <MetaDivider />
        <span className="text-muted-foreground">
          of <span className="numeric">{result.totalRows}</span>{" "}
          {result.totalRows === 1 ? "row" : "rows"} in {result.fileName}
        </span>
      </p>

      {problems.length === 0 ? (
        <EmptyState
          icon={CircleCheckIcon}
          title="All rows imported"
          description="Every row became a vendor. Nothing needs a second look."
        />
      ) : (
        <div className="max-h-[50svh] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader className="[&_tr]:border-b">
              <TableRow className="hover:bg-transparent">
                <TableHead className={`${HEAD} w-14`}>Row</TableHead>
                <TableHead className={HEAD}>Name</TableHead>
                <TableHead className={HEAD}>Phone</TableHead>
                <TableHead className={HEAD}>Status</TableHead>
                <TableHead className={HEAD}>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {problems.map((row) => (
                <TableRow key={row.row} className="hover:bg-transparent">
                  <TableCell
                    className={`${CELL} numeric text-[13px] text-muted-foreground`}
                  >
                    {row.row}
                  </TableCell>
                  <TableCell className={`${CELL} text-[13px]`}>
                    {row.name ?? <Blank />}
                  </TableCell>
                  <TableCell
                    className={`${CELL} numeric font-mono text-[12px] text-muted-foreground`}
                  >
                    {row.phoneNumber ?? <Blank />}
                  </TableCell>
                  <TableCell className={CELL}>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-[12px] font-medium whitespace-nowrap",
                        row.status === "duplicate"
                          ? "text-warning"
                          : "text-destructive",
                      )}
                    >
                      <span
                        aria-hidden
                        className="size-1.5 rounded-full bg-current"
                      />
                      {row.status === "duplicate" ? "Duplicate" : "Error"}
                    </span>
                  </TableCell>
                  <TableCell
                    className={`${CELL} min-w-[240px] text-[13px] whitespace-normal text-muted-foreground`}
                  >
                    {row.message}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
