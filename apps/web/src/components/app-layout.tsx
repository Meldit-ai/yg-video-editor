import type { CSSProperties } from "react"
import { ChevronRightIcon, SearchIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { Outlet, useLocation } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import { AppSidebar } from "@/components/app-sidebar"
import {
  CommandPalette,
  Kbd,
  MOD_LABEL,
  useCommandPalette,
} from "@/components/command-palette"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"

const PAGE_TITLES: Record<string, string> = {
  "/campaigns": "Campaigns",
  "/vendors": "Vendors",
  "/users": "Users",
  "/no-access": "Overview",
}

function pageTitle(pathname: string): string {
  // Nested routes (`/campaigns/:id`) have no key of their own — fall back to
  // the section they sit under, so the breadcrumb agrees with the sidebar,
  // which prefix-matches the same way.
  return (
    PAGE_TITLES[pathname] ??
    Object.entries(PAGE_TITLES).find(([path]) =>
      pathname.startsWith(`${path}/`),
    )?.[1] ??
    "Overview"
  )
}

/**
 * Chrome for every signed-in page: the rail, a sticky topbar, and the routed
 * content. Dense by design — a 48px bar, hairline borders, no shadows.
 */
export function AppLayout() {
  const { user } = useAuth()
  const location = useLocation()
  const palette = useCommandPalette()
  const reduceMotion = useReducedMotion()

  // ProtectedRoute guarantees a user; this keeps the type honest.
  if (!user) return null

  const title = pageTitle(location.pathname)
  const offset = reduceMotion ? 0 : 6

  return (
    <SidebarProvider
      style={{ "--sidebar-width": "15rem" } as CSSProperties}
    >
      <AppSidebar />

      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/80 px-3 backdrop-blur-md">
          <SidebarTrigger className="size-7 text-muted-foreground hover:text-foreground" />
          <Separator orientation="vertical" className="h-4!" />

          <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="hidden text-muted-foreground sm:inline">
              Workspace
            </span>
            <ChevronRightIcon
              aria-hidden
              className="hidden size-3.5 shrink-0 text-muted-foreground/40 sm:inline-block"
            />
            <span className="truncate font-medium">{title}</span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => palette.setOpen(true)}
              className="hidden h-7 w-44 justify-start gap-2 px-2 text-[13px] font-normal text-muted-foreground shadow-none transition-colors hover:text-foreground sm:inline-flex lg:w-56"
            >
              <SearchIcon className="size-3.5!" />
              Search…
              <span className="ml-auto flex items-center gap-1">
                <Kbd>{MOD_LABEL}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </Button>

            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              onClick={() => palette.setOpen(true)}
              className="size-8 text-muted-foreground hover:text-foreground sm:hidden"
            >
              <SearchIcon className="size-4" />
            </Button>

            <ThemeToggle />
          </div>
        </header>

        <div className="flex-1">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: offset }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
            className="mx-auto w-full max-w-[1400px] px-6 py-5"
          >
            <Outlet />
          </motion.div>
        </div>

        <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
      </SidebarInset>
    </SidebarProvider>
  )
}
