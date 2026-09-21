import { useState } from "react"
import { PencilIcon } from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/auth/auth-context"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/hooks/use-collection"

/**
 * The signed-in user's own account.
 *
 * Name only. The mobile number is the login identifier and there is no
 * self-service recovery, so it is shown but not editable here — changing it is
 * an admin action precisely because getting it wrong locks someone out.
 */
export function ProfileCard() {
  const { user, updateProfile } = useAuth()
  const [isEditing, setEditing] = useState(false)
  const [name, setName] = useState("")
  const [isSaving, setSaving] = useState(false)

  if (user === null) return null

  async function save() {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      toast.error("Name cannot be empty.")
      return
    }
    setSaving(true)
    try {
      await updateProfile(trimmed)
      setEditing(false)
      toast.success("Name updated")
    } catch (caught: unknown) {
      toast.error(errorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="py-0">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        {isEditing ? (
          <>
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save()
                if (event.key === "Escape") setEditing(false)
              }}
              className="h-8 max-w-64 text-[13px]"
            />
            <Button
              size="sm"
              className="h-8 text-[12px]"
              disabled={isSaving}
              onClick={() => void save()}
            >
              {isSaving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-[12px]"
              disabled={isSaving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium">{user.name}</p>
              <p className="numeric text-[12px] text-muted-foreground">
                {user.mobile}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-[12px]"
              onClick={() => {
                setName(user.name)
                setEditing(true)
              }}
            >
              <PencilIcon className="size-3.5" />
              Edit name
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
