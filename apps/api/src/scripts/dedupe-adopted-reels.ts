/**
 * Repoints adopted reels at the objects they were copied from, and deletes the
 * copies.
 *
 * Adoption used to download a reel and write it back into our own bucket under
 * a fresh key — but the tracker writes reels into that same bucket, so every
 * adopted reel left a second identical object. On one campaign that was 402MB
 * of 742MB stored, and one file written ten times.
 *
 * Two phases, in this order, because the order is what makes it safe:
 *
 *   1. Repoint every row at the source object, verifying first that the source
 *      really is ours and really is readable.
 *   2. Delete a copy only once no row points at it any more.
 *
 * A row whose source cannot be verified keeps its copy and is reported. Run
 * with `--apply` to write; without it nothing is changed and the plan is
 * printed.
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "../app.module.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { StorageService } from "../storage/storage.service.js";

/** The reel an adopted submission was copied from, from its file name. */
function sourceReelId(fileName: string): string | null {
  return /\[reel ([a-z0-9]+)\]/i.exec(fileName)?.[1] ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const logger = new Logger("dedupe-adopted-reels");

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["warn", "error"],
  });
  const prisma = app.get(PrismaService);
  const storage = app.get(StorageService);

  const rows = await prisma.client.videoSubmission.findMany({
    where: { active: true, fileName: { contains: "[reel " } },
    select: { id: true, fileName: true, objectKey: true, campaignId: true },
  });

  let repointed = 0;
  let skipped = 0;
  const freed: string[] = [];

  for (const row of rows) {
    const reelId = sourceReelId(row.fileName);
    if (reelId === null) {
      skipped += 1;
      continue;
    }

    const reel = await prisma.client.campaignReel.findUnique({
      where: { id: reelId },
      select: { mediaUrl: true },
    });
    if (reel === null) {
      logger.warn(`${row.fileName}: source reel is gone, keeping its copy`);
      skipped += 1;
      continue;
    }

    // Only an object in our own bucket can be referenced; anything else has to
    // keep the copy, because we cannot promise a third party keeps its file.
    const sourceKey = storage.objectKeyOf(reel.mediaUrl);
    if (sourceKey === null) {
      skipped += 1;
      continue;
    }
    if (sourceKey === row.objectKey) continue; // already repointed

    // Verified before the row moves: repointing at an unreadable object would
    // turn a working video into a broken one.
    const head = await storage.statObject(sourceKey);
    if (head === null || head.sizeBytes === 0) {
      logger.warn(`${row.fileName}: source object unreadable, keeping its copy`);
      skipped += 1;
      continue;
    }

    if (apply) {
      await prisma.client.videoSubmission.update({
        where: { id: row.id },
        data: {
          objectKey: sourceKey,
          contentType: head.contentType,
          sizeBytes: head.sizeBytes,
        },
      });
    }
    freed.push(row.objectKey);
    repointed += 1;
  }

  // Phase two. A key is only safe to delete once nothing references it — two
  // rows can share one copy, and a copy may also be some other row's source.
  let deleted = 0;
  for (const key of new Set(freed)) {
    const stillUsed = await prisma.client.videoSubmission.count({
      where: { objectKey: key, active: true },
    });
    if (stillUsed > 0) continue;
    if (apply) await storage.removeObject(key);
    deleted += 1;
  }

  logger.log(
    apply
      ? `Repointed ${repointed} row(s) and deleted ${deleted} copy(ies); ${skipped} left alone`
      : `Would repoint ${repointed} row(s) and delete ${deleted} copy(ies); ${skipped} would be left alone. Re-run with --apply.`,
  );

  await app.close();
}

void main();
