import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"

import App from "./App"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"

// Self-hosted so the UI never waits on a font CDN and never flashes fallback.
import "@fontsource-variable/geist"
import "@fontsource-variable/geist-mono"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      // Suppresses the cross-fade of every colour when the theme flips.
      disableTransitionOnChange
    >
      <TooltipProvider delayDuration={300}>
        <App />
        <Toaster position="bottom-right" closeButton />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
