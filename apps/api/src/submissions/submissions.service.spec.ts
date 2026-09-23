import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Role } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { UniquenessService } from "../uniqueness/uniqueness.service.js";
import type { StorageService } from "../storage/storage.service.js";
import { SubmissionsService } from "./submissions.service.js";

/** Mocked prisma.client.videoSubmission delegate — no Nest DI, no database. */
const submissionDelegate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};

const prisma = {
  client: {
    videoSubmission: submissionDelegate,
    // The delegates here already answer with promises, so the page read's
    // transaction is the two of them settling together.
    $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
  },
} as unknown as PrismaService;

const storageMock = {
  presignPlaybackUrl: vi.fn(),
  removeObject: vi.fn(),
  startUpload: vi.fn(),
};

const storage = storageMock as unknown as StorageService;

/** The duplicate check is fire-and-forget, so the spies are only ever
 *  asserted on for whether they were called — never awaited. */
const uniquenessMock = { onArrival: vi.fn(), withdraw: vi.fn() };
const uniqueness = uniquenessMock as unknown as UniquenessService;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  campaignId: "cmp_1",
  editorId: "usr_1",
  fileName: "final cut.mp4",
  objectKey: "campaigns/cmp_1/abc.mp4",
  contentType: "video/mp4",
  sizeBytes: 1024,
  active: true,
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  editor: { id: "usr_1", name: "Asha" },
  ...overrides,
});

const caller = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  id: "usr_1",
  mobile: "9876543210",
  name: "Asha",
  role: Role.EDITOR,
  rateCard: null,
  active: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const admin = caller({ id: "usr_admin", name: "Ravi", role: Role.ADMIN });
const editor = caller();

const upload = (overrides: Record<string, unknown> = {}) => ({
  originalname: "final cut.mp4",
  mimetype: "video/mp4",
  size: 1024,
  objectKey: "campaigns/cmp_1/abc.mp4",
  ...overrides,
});

describe("SubmissionsService", () => {
  let service: SubmissionsService;

  beforeEach(() => {
    vi.resetAllMocks();
    storageMock.presignPlaybackUrl.mockResolvedValue(
      "https://signed.example/v",
    );
    submissionDelegate.count.mockResolvedValue(0);
    service = new SubmissionsService(prisma, storage, uniqueness);
  });

  describe("findAll", () => {
    it("shows an editor only their own submissions", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", editor);

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            campaignId: "cmp_1",
            active: true,
            editorId: "usr_1",
            source: "EDITOR",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      );
    });

    it("puts the least duplicated first for the campaign feed", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", admin, { sort: "original" });

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Label first — UNIQUE, PARTIAL, DUPLICATE is the enum's declared
          // order — then by match value within a label. Nulls last, or videos
          // no check has reached yet would open the feed presented as the
          // most original ones.
          orderBy: [
            { uniqueness: { sort: "asc", nulls: "last" } },
            { duplicationScore: { sort: "asc", nulls: "last" } },
            { createdAt: "desc" },
            { id: "desc" },
          ],
        }),
      );
    });

    it("puts the most duplicated first when asked for the reverse", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", admin, { sort: "duplicate" });

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { uniqueness: { sort: "desc", nulls: "last" } },
            { duplicationScore: { sort: "desc", nulls: "last" } },
            { createdAt: "desc" },
            { id: "desc" },
          ],
        }),
      );
    });

    it("narrows to flagged videos without loosening the scoping", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", editor, { flagged: true });

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            campaignId: "cmp_1",
            active: true,
            editorId: "usr_1",
            source: "EDITOR",
            overThreshold: true,
          },
        }),
      );
    });

    it("shows an admin every editor's submissions", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", admin);

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaignId: "cmp_1", active: true, source: "EDITOR" },
        }),
      );
    });

    it("reads the tracker timeline only when asked for it", async () => {
      // The two are separate workflows sharing a table. Without an explicit
      // source the campaign feed means the editors' hand-ins, so reels pulled
      // in from the tracker must not appear in it.
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", admin, { source: "TRACKER" });

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { campaignId: "cmp_1", active: true, source: "TRACKER" },
        }),
      );
    });

    it("hands back a signed playback URL rather than the object key", async () => {
      submissionDelegate.findMany.mockResolvedValue([row()]);

      const {
        items: [first],
      } = await service.findAll("cmp_1", editor);

      expect(storageMock.presignPlaybackUrl).toHaveBeenCalledWith(
        "campaigns/cmp_1/abc.mp4",
        "final cut.mp4",
        "video/mp4",
      );
      expect(first).toMatchObject({
        id: "sub_1",
        editorName: "Asha",
        playbackUrl: "https://signed.example/v",
      });
      // The key is the one thing a browser must never learn: it is the only
      // handle that outlives a signature.
      expect(first).not.toHaveProperty("objectKey");
      expect(first!.playbackExpiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("reads one page and says where the next one starts", async () => {
      submissionDelegate.findMany.mockResolvedValue([row()]);
      submissionDelegate.count.mockResolvedValue(97);

      const page = await service.findAll("cmp_1", admin, { take: 1, skip: 24 });

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1, skip: 24 }),
      );
      // The count is of the whole filtered list, not of the page: a reader is
      // told there are 97 before 97 have been loaded.
      expect(page.total).toBe(97);
      expect(page.nextSkip).toBe(25);
    });

    it("ends the list rather than pointing past it", async () => {
      submissionDelegate.findMany.mockResolvedValue([row(), row({ id: "s2" })]);
      submissionDelegate.count.mockResolvedValue(12);

      const page = await service.findAll("cmp_1", admin, { take: 5, skip: 10 });

      expect(page.nextSkip).toBeNull();
    });

    it("counts the same list it returns, not every video on the campaign", async () => {
      submissionDelegate.findMany.mockResolvedValue([]);

      await service.findAll("cmp_1", editor, { uniqueness: "DUPLICATE" });

      // Same `where` for both halves, or "24 of 97" counts videos this caller
      // cannot see and the list never reaches its own total.
      const read = submissionDelegate.findMany.mock.calls[0]?.[0];
      const counted = submissionDelegate.count.mock.calls[0]?.[0];
      expect(counted?.where).toEqual(read?.where);
    });

    it("hands back the whole list when no page is asked for", async () => {
      submissionDelegate.findMany.mockResolvedValue([row()]);
      submissionDelegate.count.mockResolvedValue(1);

      const page = await service.findAll("cmp_1", admin);

      expect(submissionDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: undefined, skip: undefined }),
      );
      expect(page.nextSkip).toBeNull();
    });
  });

  describe("create", () => {
    it("records the upload against the caller", async () => {
      submissionDelegate.create.mockResolvedValue(row());

      await service.create("cmp_1", editor, upload());

      expect(submissionDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            campaignId: "cmp_1",
            editorId: "usr_1",
            fileName: "final cut.mp4",
            objectKey: "campaigns/cmp_1/abc.mp4",
            contentType: "video/mp4",
            sizeBytes: 1024,
            contentSha256: null,
          },
        }),
      );
    });

    it("stores the byte identity the storage engine measured", async () => {
      submissionDelegate.create.mockResolvedValue(row());

      await service.create("cmp_1", editor, upload({ sha256: "ab".repeat(32) }));

      expect(submissionDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contentSha256: "ab".repeat(32) }),
        }),
      );
    });

    it("hands the new video to the classifier without waiting for it", async () => {
      submissionDelegate.create.mockResolvedValue(row());

      await service.create("cmp_1", editor, upload());

      expect(uniquenessMock.onArrival).toHaveBeenCalledWith("submission", "cmp_1");
    });

    it("stores the display name, never a path from the uploader's machine", async () => {
      submissionDelegate.create.mockResolvedValue(row());

      await service.create(
        "cmp_1",
        editor,
        upload({ originalname: "C:\\clips\\final.mp4" }),
      );

      expect(submissionDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fileName: "final.mp4" }),
        }),
      );
    });

    it("rejects a request that carried no file", async () => {
      await expect(service.create("cmp_1", editor, undefined)).rejects.toThrow(
        BadRequestException,
      );
      expect(submissionDelegate.create).not.toHaveBeenCalled();
    });

    it("deletes the object when the row cannot be written", async () => {
      // The bytes are already in the bucket by the time this runs, and multer's
      // own cleanup hook cannot fire this late.
      storageMock.removeObject.mockResolvedValue(undefined);
      submissionDelegate.create.mockRejectedValue(new Error("database is down"));

      await expect(service.create("cmp_1", editor, upload())).rejects.toThrow(
        "database is down",
      );

      expect(storageMock.removeObject).toHaveBeenCalledWith(
        "campaigns/cmp_1/abc.mp4",
      );
    });

    it("deletes the object behind an empty upload instead of recording it", async () => {
      storageMock.removeObject.mockResolvedValue(undefined);

      await expect(
        service.create("cmp_1", editor, upload({ size: 0 })),
      ).rejects.toThrow(BadRequestException);

      // Nothing will ever point at those bytes again, so they go now.
      expect(storageMock.removeObject).toHaveBeenCalledWith(
        "campaigns/cmp_1/abc.mp4",
      );
      expect(submissionDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("soft-deletes and leaves the video in storage", async () => {
      submissionDelegate.findFirst.mockResolvedValue(row());
      submissionDelegate.update.mockResolvedValue(row({ active: false }));

      await service.remove("cmp_1", "sub_1", editor);

      expect(submissionDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "sub_1" },
          data: { active: false },
        }),
      );
      // Soft delete means the bytes stay: nothing here removes an object.
      expect(storageMock.removeObject).not.toHaveBeenCalled();
    });

    it("tells the classifier when a video others were labelled against goes away", async () => {
      for (const uniquenessLabel of ["UNIQUE", "PARTIAL"]) {
        uniquenessMock.withdraw.mockClear();
        submissionDelegate.findFirst.mockResolvedValue(row({ uniqueness: uniquenessLabel }));
        submissionDelegate.update.mockResolvedValue(row({ active: false }));

        await service.remove("cmp_1", "sub_1", editor);

        expect(uniquenessMock.withdraw).toHaveBeenCalledWith("submission", "cmp_1", "sub_1");
      }
    });

    it("does not bother the classifier for a DUPLICATE or an unchecked video", async () => {
      for (const uniquenessLabel of ["DUPLICATE", null]) {
        uniquenessMock.withdraw.mockClear();
        submissionDelegate.findFirst.mockResolvedValue(row({ uniqueness: uniquenessLabel }));
        submissionDelegate.update.mockResolvedValue(row({ active: false }));

        await service.remove("cmp_1", "sub_1", editor);

        expect(uniquenessMock.withdraw).not.toHaveBeenCalled();
      }
    });

    it("looks the row up within the caller's scope", async () => {
      submissionDelegate.findFirst.mockResolvedValue(row());
      submissionDelegate.update.mockResolvedValue(row({ active: false }));

      await service.remove("cmp_1", "sub_1", editor);

      expect(submissionDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            campaignId: "cmp_1",
            active: true,
            editorId: "usr_1",
            id: "sub_1",
          },
        }),
      );
    });

    it("404s another editor's submission rather than admitting it exists", async () => {
      // The scoped lookup simply does not find it — indistinguishable from an
      // id that was never real.
      submissionDelegate.findFirst.mockResolvedValue(null);

      await expect(service.remove("cmp_1", "sub_9", editor)).rejects.toThrow(
        NotFoundException,
      );
      expect(submissionDelegate.update).not.toHaveBeenCalled();
    });

    it("lets an admin remove any submission on the campaign", async () => {
      submissionDelegate.findFirst.mockResolvedValue(
        row({ editorId: "usr_someone_else" }),
      );
      submissionDelegate.update.mockResolvedValue(row({ active: false }));

      await expect(
        service.remove("cmp_1", "sub_1", admin),
      ).resolves.toMatchObject({ id: "sub_1" });
    });
  });
});
