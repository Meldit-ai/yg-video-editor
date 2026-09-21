import { useEffect, useMemo, useRef, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  MoreHorizontalIcon,
  PencilIcon,
  SearchIcon,
  SearchXIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

import { useAuth } from "@/auth/auth-context"
import { Kbd } from "@/components/command-palette"
import { EmptyState } from "@/components/empty-state"
import { MetaDivider, PageHeader } from "@/components/page-header"
import { RateApprovalQueue } from "@/components/rate-approval-queue"
import { RoleBadge } from "@/components/status-badge"
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { fullDate, initials, rupees, shortDate } from "@/lib/format"
import { ROLES, type User } from "@/lib/types"

// Mirrors the server rule in apps/api/src/users/dto/create-user.dto.ts.
const MOBILE_PATTERN = /^\+?[0-9]{10,15}$/

// Whole rupees, or up to two paise digits — the same shape the DTO accepts
// (@IsNumber with maxDecimalPlaces: 2, @Min(0)).
const RATE_CARD_PATTERN = /^\d+(\.\d{1,2})?$/

const userFormSchema = z
  .object({
    mobile: z
      .string()
      .regex(MOBILE_PATTERN, "Must be 10-15 digits, optionally starting with +"),
    name: z.string().trim().min(1, "Name is required"),
    role: z.enum(ROLES),
    // Held as a string, not a number: an empty <input> hands back "", and NaN
    // is not a value a form field can round-trip. Parsed on submit.
    rateCard: z.string().trim(),
  })
  // Only editors have a rate, so only editors are held to its format —
  // otherwise a stale value left behind by switching to Admin would block the
  // save with an error under a field that is no longer on screen.
  .refine(
    (values) =>
      values.role !== "EDITOR" ||
      values.rateCard === "" ||
      RATE_CARD_PATTERN.test(values.rateCard),
    {
      message: "Enter an amount like 1500 or 1500.50",
      path: ["rateCard"],
    },
  )

type UserFormValues = z.infer<typeof userFormSchema>

const BLANK_USER: UserFormValues = {
  mobile: "",
  name: "",
  role: "EDITOR",
  rateCard: "",
}

/** Person, mobile, role, rate, added, actions. */
const COLUMN_COUNT = 6

const CELL = "px-3 py-0"
const HEAD =
  "h-8 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"

/**
 * A stored rate as the field should show it: "1500", "1750.50". Plain
 * String() would render 1750.50 as "1750.5", which reads as a different
 * number from the ₹1,750.50 in the table it was just opened from.
 */
function rateCardInput(rateCard: number | null): string {
  if (rateCard === null) return ""
  return Number.isInteger(rateCard) ? String(rateCard) : rateCard.toFixed(2)
}

/** Digits only, so "+91 98765 43210" still matches a typed "9876". */
function digits(value: string): string {
  return value.replace(/\D/g, "")
}

export function UsersPage() {
  const { user: currentUser } = useAuth()
  const { items, isLoading, error, refetch } = useCollection<User>("/users")

  // null while creating; a User while editing.
  const [editing, setEditing] = useState<User | null>(null)
  const [isFormOpen, setFormOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<User | null>(null)
  const [isDeleting, setDeleting] = useState(false)
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)

  const form = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: BLANK_USER,
  })

  // "/" jumps to the filter, the way it does in every dense tool. Anything
  // that already owns the keyboard — a field, a dialog, a menu — keeps it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
        const tag = target.tagName
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      }
      if (
        document.querySelector(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      ) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const { adminCount, editorCount } = useMemo(() => {
    const admins = items.filter((user) => user.role === "ADMIN").length
    return { adminCount: admins, editorCount: items.length - admins }
  }, [items])

  // Client-side only: the list is small and the server has no search param.
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return items
    const termDigits = digits(term)
    return items.filter(
      (user) =>
        user.name.toLowerCase().includes(term) ||
        (termDigits.length > 0 && digits(user.mobile).includes(termDigits)),
    )
  }, [items, query])

  function openCreate() {
    setEditing(null)
    form.reset(BLANK_USER)
    setFormOpen(true)
  }

  function openEdit(user: User) {
    setEditing(user)
    form.reset({
      mobile: user.mobile,
      name: user.name,
      role: user.role,
      rateCard: rateCardInput(user.rateCard),
    })
    setFormOpen(true)
  }

  async function onSubmit(values: UserFormValues) {
    // Exactly the four keys the DTOs declare — the API runs with
    // forbidNonWhitelisted. An admin has no rate card, and sending it for one
    // is a 400, so the role decides the value rather than the hidden field.
    const payload = {
      mobile: values.mobile,
      name: values.name,
      role: values.role,
      rateCard:
        values.role === "EDITOR" && values.rateCard !== ""
          ? Number(values.rateCard)
          : null,
    }

    try {
      if (editing) {
        await api.patch<User>(`/users/${editing.id}`, payload)
        toast.success(`Updated ${values.name}`)
      } else {
        await api.post<User>("/users", payload)
        toast.success(`Added ${values.name}`)
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
      await api.delete<User>(`/users/${pendingDelete.id}`)
      toast.success(`Removed ${pendingDelete.name}`)
      setPendingDelete(null)
      await refetch()
    } catch (caught) {
      toast.error(errorMessage(caught))
    } finally {
      setDeleting(false)
    }
  }

  // The API rejects an admin deleting or demoting themselves (400). Keeping
  // those actions off your own row makes the rule visible instead of leaving
  // you to discover it as an error.
  const isSelf = (user: User) => user.id === currentUser?.id
  const isEditingSelf = editing !== null && isSelf(editing)
  // Watched, not read once: the rate-card field appears and disappears with
  // the role picked in this dialog, not the role already saved on the row.
  const selectedRole = form.watch("role")
  const isSubmitting = form.formState.isSubmitting
  const isFiltering = query.trim().length > 0
  const showTable = !isLoading && !error && visible.length > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Users"
        description="Everyone who can sign in, and what they are allowed to do."
        meta={
          <>
            <span>
              <span className="numeric text-foreground">{adminCount}</span>{" "}
              {adminCount === 1 ? "admin" : "admins"}
            </span>
            <MetaDivider />
            <span>
              <span className="numeric text-foreground">{editorCount}</span>{" "}
              {editorCount === 1 ? "editor" : "editors"}
            </span>
          </>
        }
        action={
          <Button size="sm" onClick={openCreate}>
            <UserPlusIcon />
            Add user
          </Button>
        }
      />

      {/* Rate asks live beside the people they concern: deciding one is a
          judgement about an editor, and their rate card is on this page. */}
      <section className="space-y-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Rate requests
          </h2>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
        <RateApprovalQueue />
      </section>

      <div className="panel-sheen overflow-hidden rounded-lg border bg-card">
        <div className="flex items-center gap-3 border-b px-2 py-2">
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
              aria-label="Filter users by name or mobile"
              placeholder="Filter by name or mobile…"
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

          {isFiltering && !isLoading && !error && (
            <p className="numeric ml-auto text-[11px] text-muted-foreground">
              {visible.length} of {items.length}
            </p>
          )}
        </div>

        <Table>
          <TableHeader className="[&_tr]:border-b">
            <TableRow className="hover:bg-transparent">
              <TableHead className={HEAD}>Person</TableHead>
              <TableHead className={HEAD}>Mobile</TableHead>
              <TableHead className={HEAD}>Role</TableHead>
              <TableHead className={HEAD}>Rate / video</TableHead>
              <TableHead className={HEAD}>Added</TableHead>
              <TableHead className={`${HEAD} w-10`}>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              [0, 1, 2, 3, 4].map((row) => (
                <TableRow key={row} className="hover:bg-transparent">
                  <TableCell className={`${CELL} h-11`}>
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="size-7 rounded-[7px]" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-3 w-24" />
                  </TableCell>
                  <TableCell className={CELL}>
                    <Skeleton className="h-4 w-16 rounded-full" />
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
                    title="Couldn't load users"
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

            {!isLoading && !error && items.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="p-0 whitespace-normal"
                >
                  <EmptyState
                    icon={UsersIcon}
                    title="No users yet"
                    description="Add the first person so they can sign in with their mobile number."
                    action={
                      <Button size="sm" onClick={openCreate}>
                        <UserPlusIcon />
                        Add user
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )}

            {!isLoading && !error && items.length > 0 && visible.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="p-0 whitespace-normal"
                >
                  <EmptyState
                    icon={SearchXIcon}
                    title="No matching users"
                    description={`Nothing here matches “${query.trim()}”. Try a different name or number.`}
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
              visible.map((user) => {
                const self = isSelf(user)
                const isAdmin = user.role === "ADMIN"
                return (
                  <TableRow key={user.id} className="group/row">
                    <TableCell className={`${CELL} h-11`}>
                      <div className="flex items-center gap-2.5">
                        <Avatar className="size-7 rounded-[7px]">
                          <AvatarFallback
                            className={
                              isAdmin
                                ? "rounded-[7px] bg-primary/12 text-[10px] font-semibold text-primary ring-1 ring-primary/25 ring-inset"
                                : "rounded-[7px] bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border ring-inset"
                            }
                          >
                            {initials(user.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[13px] font-medium">
                            {user.name}
                          </span>
                          {self && (
                            <span className="rounded border border-border bg-muted/60 px-1 py-px text-[10px] leading-[14px] font-medium text-muted-foreground">
                              You
                            </span>
                          )}
                        </span>
                      </div>
                    </TableCell>

                    <TableCell className={CELL}>
                      <span className="numeric font-mono text-[12px] text-muted-foreground">
                        {user.mobile}
                      </span>
                    </TableCell>

                    <TableCell className={CELL}>
                      <RoleBadge role={user.role} />
                    </TableCell>

                    <TableCell className={CELL}>
                      {user.rateCard === null ? (
                        <span
                          className="text-[13px] text-muted-foreground/60"
                          title={
                            isAdmin
                              ? "Admins do not have a rate card"
                              : "No rate agreed yet"
                          }
                        >
                          —
                        </span>
                      ) : (
                        <span className="numeric text-[13px]">
                          {rupees(user.rateCard)}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className={CELL}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <time
                            dateTime={user.createdAt}
                            tabIndex={0}
                            className="numeric rounded-sm text-[13px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                          >
                            {shortDate(user.createdAt)}
                          </time>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {fullDate(user.createdAt)}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>

                    <TableCell className={`${CELL} text-right`}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Actions for ${user.name}`}
                            className="size-7 text-muted-foreground/70 transition-colors group-hover/row:text-foreground data-[state=open]:text-foreground"
                          >
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem onSelect={() => openEdit(user)}>
                            <PencilIcon />
                            Edit details
                          </DropdownMenuItem>
                          {!self && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => setPendingDelete(user)}
                              >
                                <Trash2Icon />
                                Remove access
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={isFormOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px]">
              {editing ? "Edit user" : "Add user"}
            </DialogTitle>
            <DialogDescription className="text-[13px]">
              {editing
                ? "Changes apply the next time they load the app."
                : "They sign in with this mobile number — no password."}
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              id="user-form"
              onSubmit={form.handleSubmit(onSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px]">Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Priya Sharma"
                        autoComplete="off"
                        className="h-9 text-[13px]"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-[12px]" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="mobile"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px]">Mobile number</FormLabel>
                    <FormControl>
                      <Input
                        inputMode="tel"
                        autoComplete="off"
                        placeholder="9876543210"
                        className="numeric h-9 font-mono text-[13px]"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription className="text-[12px]">
                      10-15 digits. A leading + is fine.
                    </FormDescription>
                    <FormMessage className="text-[12px]" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-[13px]">Role</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={isEditingSelf}
                    >
                      <FormControl>
                        <SelectTrigger className="h-9 w-full text-[13px]">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role === "ADMIN" ? "Admin" : "Editor"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-[12px]">
                      {isEditingSelf
                        ? "You cannot change your own role — ask another admin."
                        : "Admins manage users and campaigns. Editors only see their work."}
                    </FormDescription>
                    <FormMessage className="text-[12px]" />
                  </FormItem>
                )}
              />

              {selectedRole === "EDITOR" && (
                <FormField
                  control={form.control}
                  name="rateCard"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-[13px]">Rate card</FormLabel>
                      {/* FormControl is a Slot: it merges id, aria-describedby
                          and aria-invalid onto its *immediate* child, so the
                          Input has to be that child. Wrapping the positioning
                          div instead would put them on the div, unbinding the
                          label and killing the invalid styling. */}
                      <div className="relative">
                        <span
                          aria-hidden
                          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-muted-foreground"
                        >
                          ₹
                        </span>
                        <FormControl>
                          <Input
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="1500"
                            className="numeric h-9 pl-6 text-[13px]"
                            {...field}
                          />
                        </FormControl>
                      </div>
                      <FormDescription className="text-[12px]">
                        What this editor charges per video. Leave it blank if
                        the rate is not agreed yet.
                      </FormDescription>
                      <FormMessage className="text-[12px]" />
                    </FormItem>
                  )}
                />
              )}
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
              form="user-form"
              disabled={isSubmitting}
            >
              {isSubmitting
                ? "Saving…"
                : editing
                  ? "Save changes"
                  : "Add user"}
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
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[15px]">
              Remove {pendingDelete?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              They lose access immediately, even if already signed in. The
              record is kept and can be restored later.
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
    </div>
  )
}
