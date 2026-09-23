import { useEffect, useState } from "react"
import { ExternalLinkIcon, EyeIcon, TrendingUpIcon } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { ListSentinel } from "@/components/list-sentinel"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { usePagedList } from "@/hooks/use-paged-list"
import { api } from "@/lib/api"
import { compact, shortDate } from "@/lib/format"
import type { EditorPostedVideo } from "@/lib/types"

/**
 * Where the editor's own work ended up, and how it did.
 *
 * Says nothing about how we know a video was posted: no mention of the
 * tracker, no match scores, no duplication verdicts. The API returns a shape
 * that has none of those in it, so there is nothing here to leak — the
 * question this answers is "did my work travel", not "how was it found".
 *
 * Lives in its own tab, so an editor with nothing posted yet gets an empty
 * state rather than a blank screen.
 */
/** Stable identity for "not loaded yet", so paging does not see a new list. */
const EMPTY_VIDEOS: EditorPostedVideo[] = []

export function PostedVideos({ campaignId }: { campaignId: string }) {
  const [videos, setVideos] = useState<EditorPostedVideo[] | null>(null)
  // Above the early returns below: a hook cannot be reached conditionally.
  const paged = usePagedList(videos ?? EMPTY_VIDEOS)

  useEffect(() => {
    let cancelled = false
    api
      .get<EditorPostedVideo[]>(`/campaigns/${campaignId}/submissions/posted`)
      .then((data) => {
        if (!cancelled) setVideos(data)
      })
      .catch(() => {
        // Falls back to the empty state rather than an error banner: the
        // submissions tab is the working half of this screen, and a failure
        // here should not shout over it.
        if (!cancelled) setVideos([])
      })
    return () => {
      cancelled = true
    }
  }, [campaignId])

  if (videos === null) return <Skeleton className="h-24 w-full rounded-xl" />
  if (videos.length === 0) {
    // It has its own tab now, so saying nothing would look broken. Stacked as
    // a panel this rendered nothing at all, which was right there.
    return (
      <EmptyState
        icon={TrendingUpIcon}
        title="Nothing posted yet"
        description="When one of your videos is posted on Instagram, it shows up here with how it performed."
      />
    )
  }

  // What every posted video of theirs earned together — the headline an
  // editor actually wants from this panel.
  const counted = videos.filter(
    (video) => video.totalEngagement.views !== null,
  )
  const totalViews =
    counted.length === 0
      ? null
      : counted.reduce(
          (sum, video) => sum + (video.totalEngagement.views ?? 0),
          0,
        )
  const totalPosts = videos.reduce(
    (sum, video) => sum + video.totalEngagement.totalPosts,
    0,
  )

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <p className="text-[12px] text-muted-foreground">
          {videos.length === 1
            ? "1 of your videos"
            : `${videos.length} of your videos`}{" "}
          {totalPosts === videos.length
            ? "has been posted"
            : `posted across ${totalPosts} accounts`}
          .
        </p>
        <span aria-hidden className="h-px flex-1 bg-border" />
        {totalViews !== null && (
          <span className="flex shrink-0 items-baseline gap-1.5">
            <TrendingUpIcon className="size-3.5 self-center text-muted-foreground" />
            <span className="numeric text-[15px] font-semibold">
              {compact(totalViews)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {videos[0]?.totalEngagement.viewsFromReach ? "reach" : "views"}
            </span>
          </span>
        )}
      </div>

      <Card className="overflow-hidden py-0">
        <CardContent className="divide-y p-0">
          {paged.visible.map((video) => (
            <PostedRow key={video.submissionId} video={video} />
          ))}
        </CardContent>
      </Card>
      {paged.hasMore && (
        <ListSentinel
          ref={paged.sentinelRef}
          shown={paged.shown}
          total={videos.length}
          noun="videos"
        />
      )}
    </section>
  )
}

function PostedRow({ video }: { video: EditorPostedVideo }) {
  const [isOpen, setOpen] = useState(false)
  const total = video.totalEngagement

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((open) => !open)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span
          className="min-w-0 flex-1 truncate text-[13px]"
          title={video.fileName}
        >
          {video.fileName}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {total.totalPosts === 1 ? "1 post" : `${total.totalPosts} posts`}
        </span>
        <span className="flex shrink-0 items-baseline gap-1.5">
          <EyeIcon className="size-3.5 self-center text-muted-foreground" />
          <span className="numeric text-[14px] font-semibold">
            {total.views === null ? "—" : compact(total.views)}
          </span>
        </span>
      </button>

      {/* The accounts, only when asked. A campaign can hold forty of these. */}
      {isOpen && (
        <ul className="divide-y border-t bg-muted/20">
          {video.posts.map((post, index) => (
            <li
              key={`${post.username}-${index}`}
              className="flex items-center gap-3 px-4 py-2 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">@{post.username}</span>
              <span className="numeric shrink-0 text-muted-foreground">
                {post.engagement?.views === null ||
                post.engagement === null
                  ? "No counts"
                  : `${compact(post.engagement.views)} views`}
              </span>
              <span className="numeric w-20 shrink-0 text-right text-muted-foreground">
                {post.postedAt === null ? "—" : shortDate(post.postedAt)}
              </span>
              {post.permalink !== null && (
                <a
                  href={post.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`Open @${post.username}'s post`}
                >
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
