/**
 * One-off: label every existing video under the incremental classifier.
 *
 * Rows scored by the old all-pairs run carry a `duplicationCheckedAt` but no
 * `uniqueness`, which the four-state model reads as "unreadable" — so the
 * boot sweep, which only picks up rows with neither, leaves them alone. A
 * rebuild resets both columns and replays the campaign in arrival order,
 * which is exactly what a first labelling should be. The engine caches
 * fingerprints and pair scores by URL, so this costs pair arithmetic, not
 * re-ingestion.
 *
 * Campaigns are replayed one at a time, submissions then reels, so the
 * engine's queue is never asked for more than one campaign's worth of room.
 *
 *   cd apps/api && pnpm build && node dist/scripts/backfill-uniqueness.js
 *
 * `UNIQUENESS_SWEEP_ON_BOOT` is forced off for this process so the service
 * does not also start sweeping behind the script's back.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { UniquenessService } from "../uniqueness/uniqueness.service.js";

process.loadEnvFile();
process.env.UNIQUENESS_SWEEP_ON_BOOT = "false";

const app = await NestFactory.createApplicationContext(AppModule, {
  logger: ["log", "warn", "error"],
});

try {
  const prisma = app.get(PrismaService);
  const uniqueness = app.get(UniquenessService);

  const campaigns = await prisma.client.campaign.findMany({
    where: { active: true },
    select: {
      id: true,
      title: true,
      _count: {
        select: {
          submissions: { where: { active: true } },
          reels: { where: { active: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Backfilling uniqueness on ${campaigns.length} campaign(s)`);

  for (const campaign of campaigns) {
    // A kind with nothing on the campaign is skipped rather than replayed, so
    // the history does not gain an empty run per campaign.
    const kinds = [
      ...(campaign._count.submissions > 0 ? (["submission"] as const) : []),
      ...(campaign._count.reels > 0 ? (["reel"] as const) : []),
    ];
    for (const kind of kinds) {
      console.log(`  ${campaign.title} (${campaign.id}): ${kind}s`);
      await uniqueness.rebuildAndWait(kind, campaign.id);
    }
  }

  console.log("Done.");
} finally {
  await app.close();
}
