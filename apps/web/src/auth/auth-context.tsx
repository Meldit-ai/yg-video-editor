import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { api, tokenStorage } from "@/lib/api"
import type { User } from "@/lib/types"

interface VerifyOtpResponse {
  token: string
  user: User
}

export interface AuthContextValue {
  user: User | null
  /** True while the stored token is being exchanged for the session on mount. */
  isLoading: boolean
  requestOtp: (mobile: string) => Promise<void>
  verifyOtp: (mobile: string, otp: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  // Only block the first paint when there is actually a token to verify;
  // otherwise the login page renders immediately.
  const [isLoading, setIsLoading] = useState(() => tokenStorage.get() !== null)

  useEffect(() => {
    if (tokenStorage.get() === null) {
      setIsLoading(false)
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const me = await api.get<User>("/auth/me")
        if (!cancelled) setUser(me)
      } catch {
        // Expired, revoked, or issued for a deleted account.
        tokenStorage.clear()
        if (!cancelled) setUser(null)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const requestOtp = useCallback(async (mobile: string) => {
    await api.post<{ sent: true }>("/auth/request-otp", { mobile })
  }, [])

  const verifyOtp = useCallback(async (mobile: string, otp: string) => {
    const result = await api.post<VerifyOtpResponse>("/auth/verify-otp", {
      mobile,
      otp,
    })
    tokenStorage.set(result.token)
    setUser(result.user)
  }, [])

  const logout = useCallback(() => {
    tokenStorage.clear()
    setUser(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ user, isLoading, requestOtp, verifyOtp, logout }),
    [user, isLoading, requestOtp, verifyOtp, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (context === null) {
    throw new Error("useAuth must be used inside <AuthProvider>")
  }
  return context
}
