/**
 * Thin fetch wrapper around the API. Requests go to the relative "/api" prefix
 * so Vite's dev proxy (and any reverse proxy in production) handles the origin.
 */

const API_PREFIX = "/api"
const TOKEN_KEY = "yg-video-editor.token"
const LOGIN_PATH = "/login"

/** An error carrying the HTTP status, so callers can branch on 401/403/404. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/**
 * localStorage access throws outright in some privacy modes, so every call is
 * guarded: losing the token is recoverable, a crashed render is not.
 */
export const tokenStorage = {
  get(): string | null {
    try {
      return window.localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token)
    } catch {
      /* ignore — the session just will not survive a reload */
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* ignore */
    }
  },
}

type Method = "GET" | "POST" | "PATCH" | "DELETE"

/** Send an expired/rejected session back to the login page, once. */
function redirectToLogin(): void {
  if (typeof window === "undefined") return
  // Guard against a redirect loop: the login page itself calls the API.
  if (window.location.pathname === LOGIN_PATH) return
  window.location.replace(LOGIN_PATH)
}

/**
 * Nest returns { message } as a string, or as an array of strings when the
 * global ValidationPipe rejects a body.
 */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = response.statusText || `Request failed (${response.status})`
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return fallback
  }
  if (typeof payload !== "object" || payload === null) return fallback

  const { message } = payload as { message?: unknown }
  if (typeof message === "string" && message.length > 0) return message
  if (Array.isArray(message)) {
    const parts = message.filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    if (parts.length > 0) return parts.join(", ")
  }
  return fallback
}

interface SendOptions {
  headers?: Record<string, string>
  body?: BodyInit
}

/**
 * One request with every cross-cutting concern applied: bearer token, a
 * readable message for a network failure, the 401 bounce, and an ApiError
 * carrying the status. Returns the raw Response, so callers that want a blob
 * or an empty body are not forced through JSON.
 */
async function send(
  method: Method,
  path: string,
  options: SendOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers }
  const token = tokenStorage.get()
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      body: options.body,
    })
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection.")
  }

  if (response.status === 401) {
    tokenStorage.clear()
    redirectToLogin()
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readErrorMessage(response))
  }

  return response
}

/** 204 and an empty body both mean "no content", not "invalid JSON". */
async function parseJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (text.length === 0) return undefined as T
  return JSON.parse(text) as T
}

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await send(method, path, {
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return parseJson<T>(response)
}

/** The download name the server asked for, if it gave one. */
function fileNameFrom(response: Response, fallback: string): string {
  // Readable without any CORS expose-headers dance, because /api is
  // same-origin through the dev proxy and in production alike.
  const disposition = response.headers.get("Content-Disposition")
  const match = disposition?.match(/filename="?([^";]+)"?/i)
  return match?.[1]?.trim() || fallback
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>("GET", path)
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body)
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>("PATCH", path, body)
  },
  delete<T>(path: string): Promise<T> {
    return request<T>("DELETE", path)
  },

  /**
   * Multipart POST. Deliberately sets no Content-Type: only the browser knows
   * the multipart boundary, and naming the type by hand omits it.
   */
  async postForm<T>(path: string, body: FormData): Promise<T> {
    return parseJson<T>(await send("POST", path, { body }))
  },

  /**
   * Fetch a binary response and hand it to the browser as a download.
   *
   * Goes through fetch rather than a plain <a href> so the Authorization
   * header travels with it — these endpoints are admin-only.
   */
  async download(path: string, fallbackFileName: string): Promise<void> {
    const response = await send("GET", path)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)

    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileNameFrom(response, fallbackFileName)
    document.body.append(anchor)
    anchor.click()
    anchor.remove()

    // Safari cancels an in-flight download if the URL is revoked synchronously.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  },
}
