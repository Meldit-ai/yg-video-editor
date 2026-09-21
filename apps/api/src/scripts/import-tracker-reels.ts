/**
 * One-off: import a tracker campaign's Instagram reels straight from the
 * tracker's production database, in Instagram post order.
 *
 * The HTTP import (`POST .../reels/import`) goes through the tracker API and
 * is capped at one 200-post page; a real campaign carries thousands. This
 * reads `VendorMessages` directly over a read-only connection and writes the
 * same rows `ReelsService.importFromTracker` would — through `reelRowFrom`,
 * so a later API import updates them in place and never touches a label.
 *
 *   ssh -f -N -L 5433:localhost:5432 root@<tracker host>       # once
 *   cd apps/api && pnpm build
 *   node dist/scripts/import-tracker-reels.js --tracker-campaign <id> [--limit N] [--dry-run]
 *
 * It only imports. Classification is the admin's "Check duplicates" button,
 * or the sweep on the next API start — which is exactly why `--limit` exists:
 * every pending reel on a campaign is work the classifier will pick up.
 */
import { parseArgs } from "node:util";
import { NestFactory } from "@nestjs/core";
import { CampaignStatus } from "@repo/database";
import pg from "pg";
import { AppModule } from "../app.module.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { headMediaAll } from "../reels/media-head.js";
import { reelRowFrom, withMediaIdentity } from "../reels/reels.service.js";
import { toTrackerReels, type VendorMessageRow } from "./tracker-rows.js";

process.loadEnvFile();
process.env.UNIQUENESS_SWEEP_ON_BOOT = "false";

const { values: args } = parseArgs({
  options: {
    "tracker-campaign": { type: "string" },
    limit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const trackerCampaignId = args["tracker-campaign"];
if (trackerCampaignId === undefined) {
  console.error("usage: --tracker-campaign <id> [--limit N] [--dry-run]");
  process.exit(2);
}
const limit = args.limit === undefined ? null : Number(args.limit);
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
  console.error("--limit must be a positive integer");
  process.exit(2);
}

const trackerUrl = process.env.TRACKER_DATABASE_URL;
if (trackerUrl === undefined || trackerUrl.length === 0) {
  console.error("TRACKER_DATABASE_URL is not set (see .env.example)");
  process.exit(2);
}

/* ------------------------------------------------------- read the tracker */

const tracker = new pg.Client({ connectionString: trackerUrl });
await tracker.connect();

let campaignTitle: string;
let rows: VendorMessageRow[];
try {
  const campaign = await tracker.query<{ title: string }>(
    'select title from "Campaign" where id = $1',
    [trackerCampaignId],
  );
  if (campaign.rowCount === 0) {
    console.error(`Tracker campaign ${trackerCampaignId} not found`);
    process.exit(1);
  }
  campaignTitle = campaign.rows[0]!.title;

  const platform = await tracker.query<{ id: string }>(
    `select id from "Platform" where name = 'Instagram'`,
  );
  const instagramId = platform.rows[0]?.id;
  if (instagramId === undefined) {
    console.error("The tracker has no Instagram platform row");
    process.exit(1);
  }

  // Oldest post first: position in this list is the claim to being original.
  const result = await tracker.query<VendorMessageRow>(
    `select id, message, media_urls[1] as media_url, social_username,
            "postDate", post_counts, caption, invoice_approved
       from "VendorMessages"
      where campaign_id = $1 and platform_id = $2
        and post_type = 'instareel' and hidden = false
      order by "postDate" asc, "createdAt" asc`,
    [trackerCampaignId, instagramId],
  );
  rows = result.rows;
} finally {
  await tracker.end();
}

const { reels, skipped } = toTrackerReels(rows);
const picked = limit === null ? reels : reels.slice(0, limit);

// One HEAD per reel for its size and ETag — the byte identity that lets the
// classifier call an exact re-upload a duplicate without the engine.
const heads = await headMediaAll(picked.map((reel) => reel.mediaUrl), 24);
const chosen = withMediaIdentity(picked, heads);
const known = chosen.filter((reel) => reel.mediaEtag != null).length;

console.log(`Tracker campaign "${campaignTitle}" (${trackerCampaignId})`);
console.log(
  `  ${rows.length} reel row(s) read, ${reels.length} usable, ${skipped.length} skipped, ${chosen.length} to import (${known} with a media ETag)`,
);
for (const { id, reason } of skipped) console.log(`  skipped ${id}: ${reason}`);

if (args["dry-run"]) {
  for (const reel of chosen.slice(0, 5)) {
    console.log(
      `  ${reel.postedAt?.toISOString() ?? "no date"}  @${reel.username}  ${reel.mediaUrl}`,
    );
  }
  console.log("Dry run — nothing written.");
  process.exit(0);
}

/* ---------------------------------------------------------- write locally */

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ["warn", "error"],
});

try {
  const prisma = app.get(PrismaService).client;

  const local =
    (await prisma.campaign.findFirst({
      where: { trackerCampaignId, active: true },
      select: { id: true, title: true },
    })) ??
    (await prisma.campaign.create({
      data: {
        title: campaignTitle,
        trackerCampaignId,
        trackerCampaignName: campaignTitle,
        status: CampaignStatus.ACTIVE,
      },
      select: { id: true, title: true },
    }));

  let imported = 0;
  let updated = 0;

  // Sequential and in order, so `createdAt` breaks ties between reels that
  // share a post time the same way the classifier will read them.
  for (let start = 0; start < chosen.length; start += 100) {
    const batch = chosen.slice(start, start + 100);
    await prisma.$transaction(async (tx) => {
      for (const reel of batch) {
        const where = {
          campaignId_trackerPostId: {
            campaignId: local.id,
            trackerPostId: reel.trackerPostId,
          },
        };
        const existing = await tx.campaignReel.findUnique({ where, select: { id: true } });
        await tx.campaignReel.upsert({
          where,
          create: { campaignId: local.id, ...reelRowFrom(reel) },
          update: reelRowFrom(reel),
        });
        if (existing === null) imported += 1;
        else updated += 1;
      }
    });
    console.log(`  ${Math.min(start + 100, chosen.length)}/${chosen.length} written`);
  }

  const pending = await prisma.campaignReel.count({
    where: { campaignId: local.id, active: true, uniqueness: null, checkedAt: null },
  });
  console.log(
    `Local campaign "${local.title}" (${local.id}): ${imported} imported, ${updated} updated, ${pending} pending classification.`,
  );
} finally {
  await app.close();
}
