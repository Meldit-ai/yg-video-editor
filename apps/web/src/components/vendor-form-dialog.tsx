import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"

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
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/hooks/use-collection"
import { ApiError, api } from "@/lib/api"
import type { Vendor } from "@/lib/types"

// Mirrors the server rules in apps/api/src/vendors/dto/create-vendor.dto.ts.
const PHONE_PATTERN = /^\+?[0-9]{10,15}$/

const social = z.string().trim().max(200, "At most 200 characters")

const vendorFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(120, "At most 120 characters"),
  phoneNumber: z
    .string()
    // The same normalisation the DTO applies, so what the field shows after a
    // failed save is what the server would have stored.
    .transform((value) => value.trim().replace(/[\s\-.()]/g, ""))
    .pipe(
      z
        .string()
        .regex(PHONE_PATTERN, "10–15 digits, optionally starting with +"),
    ),
  email: z
    .string()
    .trim()
    .max(254, "At most 254 characters")
    .refine(
      (value) => value === "" || z.email().safeParse(value).success,
      "Enter a valid email address",
    ),
  instagram: social,
  twitter: social,
  linkedin: social,
})

type VendorFormValues = z.infer<typeof vendorFormSchema>

const BLANK_VENDOR: VendorFormValues = {
  name: "",
  phoneNumber: "",
  email: "",
  instagram: "",
  twitter: "",
  linkedin: "",
}

function toFormValues(vendor: Vendor): VendorFormValues {
  return {
    name: vendor.name,
    phoneNumber: vendor.phoneNumber,
    email: vendor.email ?? "",
    instagram: vendor.instagram ?? "",
    twitter: vendor.twitter ?? "",
    linkedin: vendor.linkedin ?? "",
  }
}

interface VendorFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null while creating; a vendor while editing. */
  vendor: Vendor | null
  onSaved: () => Promise<void> | void
}

/**
 * Create or edit one vendor.
 *
 * The form lives in a child component on purpose: Radix unmounts a closed
 * dialog's children, so the child — and with it every field value — is rebuilt
 * on each open. That removes the need for a `form.reset` in an effect, and
 * with it the flash of the previous vendor's details.
 */
export function VendorFormDialog({
  open,
  onOpenChange,
  vendor,
  onSaved,
}: VendorFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <VendorFormBody
          vendor={vendor}
          onOpenChange={onOpenChange}
          onSaved={onSaved}
        />
      </DialogContent>
    </Dialog>
  )
}

function VendorFormBody({
  vendor,
  onOpenChange,
  onSaved,
}: Omit<VendorFormDialogProps, "open">) {
  const form = useForm<VendorFormValues>({
    resolver: zodResolver(vendorFormSchema),
    defaultValues: vendor ? toFormValues(vendor) : BLANK_VENDOR,
  })
  const isSubmitting = form.formState.isSubmitting

  async function onSubmit(values: VendorFormValues) {
    // Exactly the six keys the DTO declares — the API runs with
    // forbidNonWhitelisted — and the server turns the empty strings into null.
    const payload = {
      name: values.name,
      phoneNumber: values.phoneNumber,
      email: values.email,
      instagram: values.instagram,
      twitter: values.twitter,
      linkedin: values.linkedin,
    }

    try {
      if (vendor) {
        await api.patch<Vendor>(`/vendors/${vendor.id}`, payload)
        toast.success(`Updated ${values.name}`)
      } else {
        await api.post<Vendor>("/vendors", payload)
        toast.success(`Added ${values.name}`)
      }
      onOpenChange(false)
      await onSaved()
    } catch (caught) {
      // A number already in the directory is a problem with one field, so it
      // belongs under that field — not in a toast that scrolls away while the
      // dialog is still open.
      if (caught instanceof ApiError && caught.status === 409) {
        form.setError("phoneNumber", { message: caught.message })
        return
      }
      toast.error(errorMessage(caught))
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-[15px]">
          {vendor ? "Edit vendor" : "New vendor"}
        </DialogTitle>
        <DialogDescription className="text-[13px]">
          Contact details and socials for a vendor you work with. This does not
          create a login.
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form
          id="vendor-form"
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

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="phoneNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[13px]">Phone number</FormLabel>
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
                    10–15 digits. A leading + is fine.
                  </FormDescription>
                  <FormMessage className="text-[12px]" />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[13px]">Email</FormLabel>
                  <FormControl>
                    {/* type="text", not "email": native validation would block
                        handleSubmit before zod ever sees the value, and the
                        browser bubble is not the message we want to show. */}
                    <Input
                      type="text"
                      inputMode="email"
                      autoComplete="off"
                      placeholder="priya@example.com"
                      className="h-9 text-[13px]"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-[12px]">
                    Optional.
                  </FormDescription>
                  <FormMessage className="text-[12px]" />
                </FormItem>
              )}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase sm:col-span-2">
              Socials
            </p>

            <FormField
              control={form.control}
              name="instagram"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[13px]">Instagram</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      placeholder="@priya"
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
              name="twitter"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-[13px]">Twitter</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      placeholder="@priya"
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
              name="linkedin"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel className="text-[13px]">LinkedIn</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      placeholder="linkedin.com/in/priya"
                      className="h-9 text-[13px]"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription className="text-[12px]">
                    Handle or full profile link.
                  </FormDescription>
                  <FormMessage className="text-[12px]" />
                </FormItem>
              )}
            />
          </div>
        </form>
      </Form>

      <DialogFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          form="vendor-form"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Saving…" : vendor ? "Save changes" : "Add vendor"}
        </Button>
      </DialogFooter>
    </>
  )
}
