# Video submissions to Hetzner object storage

Date: 2026-09-10
Status: approved, implemented

## Problem

An editor opens a campaign, reads the brief, cuts a video — and then has
nowhere to put it. The campaign page needs a submission panel: pick or drag a
file, watch it upload with real progress, and play it back afterwards. The file
goes to Hetzner Object Storage (S3-compatible, bucket `meldit`, region `fsn1`),
which nothing in the repo had spoken to before.

Uploads are large by nature. A 2 GB video is three orders of magnitude bigger
than the 2 MB spreadsheet the vendors importer accepts, so none of that path's
assumptions — memory storage, a buffer in the service, a spinner in the UI —
survive the jump.

## Decisions

| Decision | Choice |
| --- | --- |
| Upload route | **Through the API**, streamed. Not a presigned PUT direct from the browser: that needs a CORS policy on the bucket, and `meldit` is shared with other services — quietly rewriting its CORS config is not ours to do. |
| Buffering | **None.** A custom multer storage engine pipes the request straight into `@aws-sdk/lib-storage`'s `Upload`, which does multipart in 5 MB parts. Peak memory is ~30 MB per upload regardless of file size. |
| Size cap | 2 GB, below `2^31` so `sizeBytes` stays an `Int`. Enforced twice: `UploadSizeGuard` reads `Content-Length` and answers 413 before a byte is read, and multer's `limits.fileSize` catches a request that lied. |
| Accepted files | Any `video/*` MIME. An untyped upload (`application/octet-stream`, which is what several browsers send for `.mkv`) is accepted only if its extension is on a known list, and is then *stored* under the MIME that extension implies. |
| Object key | `campaigns/<campaignId>/<uuid>.<ext>`. The uploader's file name never enters the key — it is kept in the row for display only. |
| Playback | A presigned `GetObject` URL, valid 6 hours, with `ResponseContentType` and `ResponseContentDisposition: inline`. The bucket stays private and no CORS policy is needed: a plain `<video src>` without `crossorigin` is an ordinary media request. Hetzner answers it with `Accept-Ranges: bytes`, so scrubbing works. |
| Visibility | An editor sees only their own submissions; an admin sees every editor's. Enforced as a `where` clause, so another editor's id is a 404, not a 403. |
| Delete | Soft, like every other model: `active = false`. The object stays in the bucket. Only a *failed* upload ever deletes bytes. |
| Progress | `XMLHttpRequest`, the first in the repo. `fetch` still cannot report request-body progress, and a video upload without a progress bar is indistinguishable from a hang. |

## Data model

```prisma
model VideoSubmission {
  id          String   @id @default(cuid())
  campaignId  String
  campaign    Campaign @relation(fields: [campaignId], references: [id])
  editorId    String
  editor      User     @relation(fields: [editorId], references: [id])
  fileName    String
  objectKey   String   @unique
  contentType String
  sizeBytes   Int
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([campaignId, active])
  @@index([editorId])
}
```

`objectKey` is the only link between a row and the bytes, and it never leaves
the server — the DTO carries a signed URL instead. `sizeBytes` is measured
server-side while streaming, not taken from the client.

## API

Nested under the campaign, because a submission has no meaning without one.
Every route sits behind `CampaignAccessGuard`.

| Route | Who | Notes |
| --- | --- | --- |
| `GET /api/campaigns/:campaignId/submissions` | any signed-in user | Newest first. Editor: own rows. Admin: all. |
| `POST /api/campaigns/:campaignId/submissions` | any signed-in user | Multipart, field `file`. 201 with the new row. |
| `DELETE /api/campaigns/:campaignId/submissions/:submissionId` | owner or admin | Soft delete; returns the withdrawn row. |

`CampaignAccessGuard` exists for one reason: **guards run before
interceptors**. It resolves the campaign through `CampaignsService.findOne`, so
an unknown, deleted, or (for an editor) paused campaign 404s *before*
`FileInterceptor` starts streaming a gigabyte into storage. Putting that check
in the handler would mean storing the file first and rejecting afterwards.

## The upload path, and what can go wrong on it

`video-upload.storage.ts` is a multer storage engine, which means it owns
everything multer does not: the key, the byte count, and every cleanup.

- **The stream is joined with `pipeline`, not `pipe`.** `pipe` does not
  propagate a destroyed source, so a cancelled request would leave the SDK
  waiting on a body that never ends.
- **Truncation does not look like an error.** At `limits.fileSize` multer emits
  `limit`, then *ends the stream cleanly*. An engine that only watched for
  errors would report a half-written video as a success. Both the `limit` event
  and `stream.truncated` are checked, and the object is deleted.
- **`upload.abort()` alone is not enough.** It raises a flag; the SDK cannot
  send `AbortMultipartUpload` while it is still blocked reading the body, so
  the body is destroyed too. Otherwise the parts dangle and are billed forever.
- **The callback fires exactly once on every path.** multer parks on
  `pendingWrites` after a limit abort; an engine that returns without calling
  back hangs the request with no response and no timeout.
- **`file.objectKey` is set at the start**, not only returned at the end:
  multer builds `_removeFile`'s argument from the file object alone when it
  aborts mid-file.

`MulterModule.registerAsync` in `SubmissionsModule` supplies these options,
because the engine needs `StorageService` injected and inline interceptor
options cannot be. Those options are scoped to the module that imports
`MulterModule` — which is what keeps the vendors importer on memory storage.

## Timeouts

Node gives every request 5 minutes by default, measured from its first byte to
its last. It is a wall clock, not an idle timeout: a healthy 2 GB upload at
5 MB/s dies at exactly five minutes. Both servers in the dev path had it —
`main.ts` raises the API's to 30 minutes, and a small Vite plugin raises the
dev server's to match, otherwise the proxy answers 408 mid-upload no matter
what the API allows.

## Storage client

Credentials live in `apps/api/.env` as `HETZNER_BUCKET_*` and are read lazily,
mirroring `PrismaService`: a machine with no bucket credentials still boots and
still serves `/api/health`, and the submission routes answer 503 naming the
missing variables.

Addressing is virtual-hosted (`meldit.fsn1.your-objectstorage.com`), which is
what Hetzner's docs recommend and what their wildcard certificate covers — a
bucket name containing a dot would not be, and would need `forcePathStyle`.
Checksum calculation and validation are both set to `WHEN_REQUIRED`: the SDK
otherwise attaches CRC32 headers to every part and hangs a stray
`x-amz-checksum-mode` parameter off every presigned URL. Hetzner tolerates both
— verified against the live bucket — but it is an S3-compatible service, not
S3, and SigV4 already signs a payload hash per part.

## Known gaps

- **No resume.** A 2 GB upload is one HTTP request; a dropped connection at 95%
  costs the whole file. The fix is a presigned multipart flow direct to the
  bucket, which brings the CORS question back with it.
- **Orphaned parts survive a crash.** If the API process dies mid-upload,
  nothing sends `AbortMultipartUpload`. A bucket lifecycle rule
  (`AbortIncompleteMultipartUpload: 1 day`) would reclaim them, but the bucket
  is shared and its lifecycle configuration is not this app's to set.
- **No review workflow.** A submission is uploaded, listed and played. There is
  no approval, no revision chain, and no comments.
