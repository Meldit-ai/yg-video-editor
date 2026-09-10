import { useState, type CSSProperties } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  ArrowRightIcon,
  Loader2Icon,
  SmartphoneIcon,
} from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useForm } from "react-hook-form"
import { Navigate, useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { z } from "zod"

import { useAuth } from "@/auth/auth-context"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { Skeleton } from "@/components/ui/skeleton"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/utils"

// Mirrors the validation the API applies, so bad numbers never reach the wire.
const MOBILE_PATTERN = /^\+?[0-9]{10,15}$/

const mobileSchema = z.object({
  mobile: z
    .string()
    .trim()
    .min(1, "Enter your mobile number.")
    .regex(MOBILE_PATTERN, "Use 10-15 digits, optionally starting with +."),
})

const otpSchema = z.object({
  otp: z
    .string()
    .length(4, "Enter the 4-digit code.")
    .regex(/^[0-9]{4}$/, "The code is 4 digits."),
})

type MobileValues = z.infer<typeof mobileSchema>
type OtpValues = z.infer<typeof otpSchema>

/*
 * Atmosphere, not decoration: a hairline grid faded out by a radial mask, and
 * one wide wash of the primary hue along the top edge. Both are driven by the
 * theme tokens so the light theme reads as the same design, just quieter.
 */
const GRID_LINE = "color-mix(in oklch, var(--foreground) 7%, transparent)"
const GRID_FADE =
  "radial-gradient(ellipse 76% 60% at 50% 38%, black 0%, transparent 100%)"

const GRID_STYLE: CSSProperties = {
  backgroundImage: `linear-gradient(to right, ${GRID_LINE} 1px, transparent 1px), linear-gradient(to bottom, ${GRID_LINE} 1px, transparent 1px)`,
  backgroundSize: "64px 64px",
  maskImage: GRID_FADE,
  WebkitMaskImage: GRID_FADE,
}

const GLOW_STYLE: CSSProperties = {
  backgroundImage:
    "radial-gradient(ellipse 66% 52% at 50% 14%, color-mix(in oklch, var(--primary) 22%, transparent) 0%, transparent 72%)",
}

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0" style={GRID_STYLE} />
      <div
        className="absolute inset-0 opacity-60 dark:opacity-100"
        style={GLOW_STYLE}
      />
    </div>
  )
}

/** Compact monogram — the only piece of brand on the screen. */
function BrandMark() {
  return (
    <div
      aria-hidden
      className="flex size-9 items-center justify-center rounded-[10px] border border-primary/25 bg-primary/10 font-mono text-[13px] font-semibold tracking-tight text-primary"
    >
      YG
    </div>
  )
}

/** Two hairline segments: enough to say "there is a second step". */
function StepProgress({ step }: { step: 1 | 2 }) {
  return (
    <div className="flex items-center gap-1">
      <span aria-hidden className="h-1 w-5 rounded-full bg-primary" />
      <span
        aria-hidden
        className={cn(
          "h-1 w-5 rounded-full transition-colors duration-200",
          step === 2 ? "bg-primary" : "bg-border",
        )}
      />
      <span className="sr-only" aria-live="polite">
        Step {step} of 2
      </span>
    </div>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function LoginPage() {
  const { user, isLoading, requestOtp, verifyOtp } = useAuth()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  // Non-null once a code has been requested: that is what switches to step 2.
  const [mobile, setMobile] = useState<string | null>(null)

  const mobileForm = useForm<MobileValues>({
    resolver: zodResolver(mobileSchema),
    defaultValues: { mobile: "" },
  })

  const otpForm = useForm<OtpValues>({
    resolver: zodResolver(otpSchema),
    defaultValues: { otp: "" },
  })

  async function onSubmitMobile(values: MobileValues) {
    try {
      await requestOtp(values.mobile)
      setMobile(values.mobile)
      otpForm.reset({ otp: "" })
      toast.success("Code sent", {
        description: `We sent a 4-digit code to ${values.mobile}.`,
      })
    } catch (error) {
      toast.error(errorMessage(error, "Could not send the code."))
    }
  }

  async function onSubmitOtp(values: OtpValues) {
    if (mobile === null) return
    try {
      await verifyOtp(mobile, values.otp)
      void navigate("/campaigns", { replace: true })
    } catch (error) {
      otpForm.reset({ otp: "" })
      toast.error(errorMessage(error, "Could not verify the code."))
    }
  }

  function changeNumber() {
    setMobile(null)
    otpForm.reset({ otp: "" })
  }

  // Never flash the form while a stored session is still being restored.
  if (isLoading) {
    return (
      <div className="relative flex min-h-svh items-center justify-center px-6 py-10">
        <Backdrop />
        <Skeleton className="relative h-[286px] w-full max-w-[380px] rounded-xl" />
      </div>
    )
  }

  if (user) return <Navigate to="/campaigns" replace />

  const isRequesting = mobileForm.formState.isSubmitting
  const isVerifying = otpForm.formState.isSubmitting
  const offset = reduceMotion ? 0 : 10
  const duration = reduceMotion ? 0 : 0.17

  return (
    <div className="relative flex min-h-svh items-center justify-center px-6 py-10">
      <Backdrop />

      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-[380px]">
        <Card className="panel-sheen w-full gap-0 border-border/70 bg-card/70 p-0 py-0 shadow-none backdrop-blur-2xl">
          <div className="px-6 pt-6 pb-5">
            <div className="flex items-center justify-between gap-3">
              <BrandMark />
              <StepProgress step={mobile === null ? 1 : 2} />
            </div>
            <h1 className="mt-3.5 text-[15px] font-semibold">
              Sign in to YG Video Editor
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Verify your registered mobile number.
            </p>
          </div>

          <div className="h-px w-full bg-linear-to-r from-transparent via-border to-transparent" />

          <div className="px-6 pt-5 pb-6">
            <AnimatePresence mode="wait" initial={false}>
              {mobile === null ? (
                <motion.div
                  key="mobile"
                  initial={{ opacity: 0, x: offset }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{
                    opacity: 0,
                    x: -offset,
                    transition: { duration: reduceMotion ? 0 : 0.11 },
                  }}
                  transition={{ duration, ease: "easeOut" }}
                >
                  <Form {...mobileForm}>
                    <form
                      className="space-y-4"
                      onSubmit={mobileForm.handleSubmit(onSubmitMobile)}
                    >
                      <FormField
                        control={mobileForm.control}
                        name="mobile"
                        render={({ field }) => (
                          <FormItem className="gap-1.5">
                            <FormLabel className="text-[13px] font-medium text-muted-foreground">
                              Mobile number
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="tel"
                                inputMode="tel"
                                autoComplete="tel"
                                autoFocus
                                placeholder="9876543210"
                                className="numeric h-10 font-mono text-[13px] tracking-tight md:text-[13px]"
                                {...field}
                              />
                            </FormControl>
                            <FormDescription className="pt-0.5 text-[12px]">
                              You will confirm with a 4-digit code on the next
                              step.
                            </FormDescription>
                            <FormMessage className="text-[12px]" />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        className="group h-10 w-full"
                        disabled={isRequesting}
                      >
                        {isRequesting ? (
                          <>
                            <Loader2Icon className="animate-spin" />
                            Sending code…
                          </>
                        ) : (
                          <>
                            Continue
                            <ArrowRightIcon className="transition-transform duration-150 group-hover:translate-x-0.5" />
                          </>
                        )}
                      </Button>
                    </form>
                  </Form>
                </motion.div>
              ) : (
                <motion.div
                  key="otp"
                  initial={{ opacity: 0, x: offset }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{
                    opacity: 0,
                    x: -offset,
                    transition: { duration: reduceMotion ? 0 : 0.11 },
                  }}
                  transition={{ duration, ease: "easeOut" }}
                >
                  <Form {...otpForm}>
                    <form
                      className="space-y-4"
                      onSubmit={otpForm.handleSubmit(onSubmitOtp)}
                    >
                      {/* The number being verified, with the escape hatch. */}
                      <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-2.5">
                        <div className="flex min-w-0 items-center gap-2">
                          <SmartphoneIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                          <span className="numeric truncate font-mono text-[13px]">
                            {mobile}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={changeNumber}
                          disabled={isVerifying}
                          aria-label="Use a different number"
                          className="shrink-0 text-[12px] font-medium text-muted-foreground hover:text-foreground"
                        >
                          Change
                        </Button>
                      </div>

                      <FormField
                        control={otpForm.control}
                        name="otp"
                        render={({ field }) => (
                          <FormItem className="gap-1.5">
                            <FormLabel className="text-[13px] font-medium text-muted-foreground">
                              Verification code
                            </FormLabel>
                            <FormControl>
                              <InputOTP
                                {...field}
                                maxLength={4}
                                autoFocus
                                disabled={isVerifying}
                                containerClassName="w-full"
                                // Four digits in means the intent is clear —
                                // do not make them reach for the button.
                                onComplete={() => {
                                  void otpForm.handleSubmit(onSubmitOtp)()
                                }}
                              >
                                <InputOTPGroup className="w-full gap-2">
                                  <OtpSlot index={0} />
                                  <OtpSlot index={1} />
                                  <OtpSlot index={2} />
                                  <OtpSlot index={3} />
                                </InputOTPGroup>
                              </InputOTP>
                            </FormControl>
                            <FormDescription className="pt-0.5 text-[12px]">
                              SMS is not wired up yet — use{" "}
                              <span className="font-mono font-medium text-foreground">
                                1234
                              </span>{" "}
                              in this build.
                            </FormDescription>
                            <FormMessage className="text-[12px]" />
                          </FormItem>
                        )}
                      />

                      <Button
                        type="submit"
                        className="h-10 w-full"
                        disabled={isVerifying}
                      >
                        {isVerifying ? (
                          <>
                            <Loader2Icon className="animate-spin" />
                            Verifying…
                          </>
                        ) : (
                          "Verify and sign in"
                        )}
                      </Button>
                    </form>
                  </Form>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </Card>

        <p className="pt-4 text-center text-[12px] text-muted-foreground">
          Accounts are created by an admin — there is no sign-up.
        </p>
      </div>
    </div>
  )
}

/** Generously sized, evenly split across the card width. */
function OtpSlot({ index }: { index: number }) {
  return (
    <InputOTPSlot
      index={index}
      className="h-12 flex-1 rounded-md border-l font-mono text-[17px] font-medium shadow-none"
    />
  )
}
