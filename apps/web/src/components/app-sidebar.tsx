import {
  BookUserIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
  UsersIcon,
} from "lucide-react"
import { NavLink, useLocation, useNavigate } from "react-router-dom"

import { useAuth } from "@/auth/auth-context"
import { RoleBadge } from "@/components/status-badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { initials } from "@/lib/format"

/**
 * Rail destinations. Dashboard and Campaigns are open to everyone — admins
 * get the dense campaign table, editors the card grid — while Vendors and
 * Users stay admin-only.
 */
const NAV_ITEMS = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboardIcon,
    adminOnly: false,
  },
  {
    to: "/campaigns",
    label: "Campaigns",
    icon: MegaphoneIcon,
    adminOnly: false,
  },
  {
    to: "/vendors",
    label: "Vendors",
    icon: BookUserIcon,
    adminOnly: true,
  },
  { to: "/users", label: "Users", icon: UsersIcon, adminOnly: true },
] as const

type NavItem = (typeof NAV_ITEMS)[number]

function NavRow({ item }: { item: NavItem }) {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const Icon = item.icon
  const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`)

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={item.label}
        className="relative h-8 gap-2.5 rounded-md px-2 text-[13px] font-normal text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground [&>svg]:text-sidebar-foreground/45 data-[active=true]:[&>svg]:text-primary"
      >
        <NavLink
          to={item.to}
          onClick={() => {
            if (isMobile) setOpenMobile(false)
          }}
        >
          {isActive && (
            <span
              aria-hidden
              className="absolute top-1/2 left-0 h-3.5 w-[2px] -translate-y-1/2 rounded-r-full bg-primary"
            />
          )}
          <Icon />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The left rail: brand, role-filtered navigation, and the account menu. Darker
 * than the content area on purpose — the chrome sits back, the work comes
 * forward.
 */
export function AppSidebar() {
  const { user, logout } = useAuth()
  const { isMobile } = useSidebar()
  const navigate = useNavigate()

  // ProtectedRoute guarantees a user; this keeps the type honest.
  if (!user) return null

  const isAdmin = user.role === "ADMIN"
  const navItems = NAV_ITEMS.filter((item) => isAdmin || !item.adminOnly)

  function signOut() {
    logout()
    void navigate("/login", { replace: true })
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-0 p-2">
        <div className="flex h-9 items-center gap-2.5 rounded-md px-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <span
            aria-hidden
            className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-primary font-mono text-[10px] font-bold tracking-tight text-primary-foreground"
          >
            YG
          </span>
          <div className="grid min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <span className="truncate text-[13px] leading-tight font-semibold tracking-tight">
              YG Video Editor
            </span>
            <span className="truncate text-[11px] leading-tight text-sidebar-foreground/50">
              {isAdmin ? "Admin workspace" : "Editor workspace"}
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel className="h-6 px-2 text-[10px] font-medium tracking-[0.08em] text-sidebar-foreground/40 uppercase">
            {isAdmin ? "Manage" : "Browse"}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {navItems.map((item) => (
                <NavRow key={item.to} item={item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={user.name}
                  aria-label={`Account menu for ${user.name}`}
                  className="h-11 gap-2.5 rounded-md px-1.5 hover:bg-sidebar-accent/60 data-[state=open]:bg-sidebar-accent group-data-[collapsible=icon]:justify-center"
                >
                  <Avatar className="size-7 rounded-[7px]">
                    <AvatarFallback className="rounded-[7px] bg-sidebar-accent text-[10px] font-medium text-sidebar-accent-foreground">
                      {initials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1 text-left group-data-[collapsible=icon]:hidden">
                    <span className="truncate text-[13px] leading-tight font-medium">
                      {user.name}
                    </span>
                    <span className="numeric truncate text-[11px] leading-tight text-sidebar-foreground/50">
                      {user.mobile}
                    </span>
                  </div>
                  <ChevronsUpDownIcon className="ml-auto size-3.5! shrink-0 text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={isMobile ? "top" : "right"}
                align="end"
                sideOffset={8}
                className="w-60"
              >
                <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
                  <Avatar className="size-7 rounded-[7px]">
                    <AvatarFallback className="rounded-[7px] bg-muted text-[10px] font-medium">
                      {initials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1">
                    <span className="truncate text-[13px] leading-tight font-medium">
                      {user.name}
                    </span>
                    <span className="numeric truncate text-[11px] leading-tight text-muted-foreground">
                      {user.mobile}
                    </span>
                  </div>
                  <RoleBadge role={user.role} />
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={signOut}
                  className="text-[13px]"
                >
                  <LogOutIcon />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
