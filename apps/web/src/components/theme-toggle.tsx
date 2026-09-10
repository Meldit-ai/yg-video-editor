import { useEffect, useState } from "react"
import { MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Light/dark switch.
 *
 * The icon is rendered only after mount: the resolved theme is unknown during
 * the first paint, so rendering it eagerly guarantees a wrong icon that
 * visibly swaps.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  const isDark = resolvedTheme === "dark"

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-foreground"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {mounted &&
            (isDark ? (
              <SunIcon className="size-4" />
            ) : (
              <MoonIcon className="size-4" />
            ))}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isDark ? "Light mode" : "Dark mode"}</TooltipContent>
    </Tooltip>
  )
}
