import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  BookUserIcon,
  LogOutIcon,
  MegaphoneIcon,
  MoonIcon,
  SunIcon,
  UsersIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { useNavigate } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  CHORD_WINDOW_MS,
  hasOpenOverlay,
  isTypingTarget,
} from "@/lib/keyboard"
import { cn } from "@/lib/utils"

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)

/** "⌘" on Apple hardware, "Ctrl" everywhere else. */
export const MOD_LABEL = IS_APPLE ? "⌘" : "Ctrl"

/**
 * A single keycap. Sized to sit inline with 11–13px UI text without
 * disturbing the line box.
 */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border/80 bg-muted px-[5px] font-sans text-[10px] leading-none font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  )
}

/**
 * Palette state, so a trigger elsewhere in the chrome (the topbar search
 * button) can drive the same instance.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false)
  return useMemo(() => ({ open, setOpen }), [open])
}

export interface CommandPaletteProps {
  /** Controlled state. Omit both props to let the palette manage itself. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * ⌘K / Ctrl+K palette: the fastest route to anything in the app.
 *
 * It also owns the `g`-prefixed navigation chords it advertises, so every hint
 * it shows is a real binding. `g c` works for everyone; `g v` and `g u`, like
 * the entries themselves, are admin-only.
 */
export function CommandPalette({
  open: openProp,
  onOpenChange,
}: CommandPaletteProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)

  const open = openProp ?? uncontrolledOpen
  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  // Read inside window listeners that are registered once.
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])

  const isAdmin = user?.role === "ADMIN"

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k") return
      if (!event.metaKey && !event.ctrlKey) return

      // Toggling closed has to work from inside the palette's own input.
      if (openRef.current) {
        event.preventDefault()
        setOpen(false)
        return
      }
      if (isTypingTarget(event.target)) return
      if (hasOpenOverlay()) return

      event.preventDefault()
      setOpen(true)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [setOpen])

  // Registered for everyone: `g c` is universal; `g v` and `g u` are
  // admin-only, and fall through to nothing for an editor.
  useEffect(() => {
    let armed = false
    let timer: number | undefined

    function disarm() {
      armed = false
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (openRef.current || hasOpenOverlay()) return
      if (isTypingTarget(event.target)) return

      if (!armed) {
        if (event.key === "g") {
          armed = true
          timer = window.setTimeout(disarm, CHORD_WINDOW_MS)
        }
        return
      }

      const destination =
        event.key === "c"
          ? "/campaigns"
          : event.key === "v" && isAdmin
            ? "/vendors"
            : event.key === "u" && isAdmin
              ? "/users"
              : null
      disarm()
      if (destination === null) return

      event.preventDefault()
      void navigate(destination)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => {
      disarm()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [isAdmin, navigate])

  const runCommand = useCallback(
    (action: () => void) => {
      setOpen(false)
      action()
    },
    [setOpen],
  )

  const isDark = resolvedTheme === "dark"

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or run a command."
      showCloseButton={false}
      className="top-[14vh] translate-y-0 border-border/80 shadow-2xl sm:max-w-[560px]"
    >
      <CommandInput placeholder="Search pages and commands…" />
      <CommandList className="max-h-[min(58vh,360px)] px-1 py-1">
        <CommandEmpty className="py-8 text-center text-[13px] text-muted-foreground">
          No matching commands.
        </CommandEmpty>

        <CommandGroup heading="Navigation">
          <CommandItem
            value="Campaigns"
            keywords={["briefs", "content", "tracker"]}
            onSelect={() =>
              runCommand(() => {
                void navigate("/campaigns")
              })
            }
            className="gap-2.5 py-2! text-[13px]"
          >
            <MegaphoneIcon className="size-4! text-muted-foreground" />
            <span>Campaigns</span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>G</Kbd>
              <Kbd>C</Kbd>
            </span>
          </CommandItem>
          {isAdmin && (
            <>
              <CommandItem
                value="Vendors"
                keywords={[
                  "contacts",
                  "directory",
                  "video editors",
                  "freelancers",
                  "import",
                ]}
                onSelect={() =>
                  runCommand(() => {
                    void navigate("/vendors")
                  })
                }
                className="gap-2.5 py-2! text-[13px]"
              >
                <BookUserIcon className="size-4! text-muted-foreground" />
                <span>Vendors</span>
                <span className="ml-auto flex items-center gap-1">
                  <Kbd>G</Kbd>
                  <Kbd>V</Kbd>
                </span>
              </CommandItem>
              <CommandItem
                value="Users"
                keywords={["people", "team", "admins", "accounts", "roles"]}
                onSelect={() =>
                  runCommand(() => {
                    void navigate("/users")
                  })
                }
                className="gap-2.5 py-2! text-[13px]"
              >
                <UsersIcon className="size-4! text-muted-foreground" />
                <span>Users</span>
                <span className="ml-auto flex items-center gap-1">
                  <Kbd>G</Kbd>
                  <Kbd>U</Kbd>
                </span>
              </CommandItem>
            </>
          )}
        </CommandGroup>
        <CommandSeparator className="my-1" />


        <CommandGroup heading="Preferences">
          <CommandItem
            value="Toggle theme"
            keywords={["dark", "light", "appearance", "mode"]}
            onSelect={() =>
              runCommand(() => setTheme(isDark ? "light" : "dark"))
            }
            className="gap-2.5 py-2! text-[13px]"
          >
            {isDark ? (
              <SunIcon className="size-4! text-muted-foreground" />
            ) : (
              <MoonIcon className="size-4! text-muted-foreground" />
            )}
            <span>Toggle theme</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {isDark ? "Dark" : "Light"}
            </span>
          </CommandItem>
          <CommandItem
            value="Log out"
            keywords={["sign out", "exit", "session"]}
            onSelect={() =>
              runCommand(() => {
                logout()
                void navigate("/login", { replace: true })
              })
            }
            className="gap-2.5 py-2! text-[13px] data-[selected=true]:text-destructive data-[selected=true]:[&>svg]:text-destructive"
          >
            <LogOutIcon className="size-4! text-muted-foreground" />
            <span>Log out</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span>Navigate</span>
          <Kbd className="ml-1.5">↵</Kbd>
          <span>Select</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>Esc</Kbd>
          <span>Close</span>
        </span>
      </div>
    </CommandDialog>
  )
}
