import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { CampaignStatus, Role, type Campaign } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { TrackerService } from "../tracker/tracker.service.js";
import { CampaignsService } from "./campaigns.service.js";

/** Mocked prisma.client.campaign delegate — no Nest DI, no database. */
const campaignDelegate = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const prisma = {
  client: { campaign: campaignDelegate },
} as unknown as PrismaService;

/** Plain stub for the tracker — the upstream is never reached from here. */
const trackerMock = {
  listCampaigns: vi.fn(),
  resolveName: vi.fn(),
};

const tracker = trackerMock as unknown as TrackerService;

const row = (overrides: Partial<Campaign> = {}): Campaign =>
  ({
    id: "cmp_1",
    title: "Launch",
    briefText: null,
    guidanceNote: null,
    status: CampaignStatus.ACTIVE,
    trackerCampaignId: null,
    trackerCampaignName: null,
    active: true,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  }) as Campaign;

/** Callers of the role-scoped reads. AuthenticatedUser is the live User row. */
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

describe("CampaignsService", () => {
  let service: CampaignsService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new CampaignsService(prisma, tracker);
  });

  describe("create", () => {
    it("defaults status to ACTIVE when the body omits it", async () => {
      campaignDelegate.create.mockResolvedValue(row());

      await service.create({ title: "Launch" });

      expect(campaignDelegate.create).toHaveBeenCalledWith({
        data: {
          title: "Launch",
          briefText: null,
          guidanceNote: null,
          trackerCampaignId: null,
          trackerCampaignName: null,
          status: CampaignStatus.ACTIVE,
        },
      });
      // Nothing to resolve when no tracker campaign was picked.
      expect(trackerMock.resolveName).not.toHaveBeenCalled();
    });

    it("keeps an explicit status and never writes the active flag", async () => {
      campaignDelegate.create.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE }),
      );

      await service.create({
        title: "Paused launch",
        status: CampaignStatus.INACTIVE,
        briefText: "Two hero cuts, 9:16.",
      });

      const arg = campaignDelegate.create.mock.calls[0]?.[0];
      expect(arg.data.status).toBe(CampaignStatus.INACTIVE);
      expect(arg.data.briefText).toBe("Two hero cuts, 9:16.");
      // active is the soft-delete flag: the DB default owns it, not the client.
      expect(arg.data).not.toHaveProperty("active");
    });

    it("resolves the tracker name server-side and stores both columns", async () => {
      trackerMock.resolveName.mockResolvedValue("Ikkis");
      campaignDelegate.create.mockResolvedValue(
        row({ trackerCampaignId: "trk-1", trackerCampaignName: "Ikkis" }),
      );

      await service.create({ title: "Launch", trackerCampaignId: "trk-1" });

      expect(trackerMock.resolveName).toHaveBeenCalledWith("trk-1");
      const arg = campaignDelegate.create.mock.calls[0]?.[0];
      expect(arg.data.trackerCampaignId).toBe("trk-1");
      // The name comes from the tracker, never from the request body.
      expect(arg.data.trackerCampaignName).toBe("Ikkis");
    });

    it("rejects a tracker id the tracker does not know, without writing", async () => {
      trackerMock.resolveName.mockResolvedValue(null);

      await expect(
        service.create({ title: "Launch", trackerCampaignId: "trk-gone" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(campaignDelegate.create).not.toHaveBeenCalled();
    });
  });

  describe("findAll as an admin", () => {
    it("returns only active rows, newest first", async () => {
      campaignDelegate.findMany.mockResolvedValue([row()]);

      const result = await service.findAll(undefined, admin);

      expect(campaignDelegate.findMany).toHaveBeenCalledWith({
        where: { active: true },
        orderBy: { createdAt: "desc" },
      });
      expect(result).toHaveLength(1);
    });

    it("applies the optional status filter alongside active=true", async () => {
      campaignDelegate.findMany.mockResolvedValue([]);

      await service.findAll(CampaignStatus.INACTIVE, admin);

      expect(campaignDelegate.findMany).toHaveBeenCalledWith({
        where: { active: true, status: CampaignStatus.INACTIVE },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("findAll as an editor", () => {
    it("pins the query to status=ACTIVE when no status is supplied", async () => {
      campaignDelegate.findMany.mockResolvedValue([row()]);

      const result = await service.findAll(undefined, editor);

      expect(campaignDelegate.findMany).toHaveBeenCalledWith({
        where: { active: true, status: CampaignStatus.ACTIVE },
        orderBy: { createdAt: "desc" },
      });
      expect(result).toHaveLength(1);
    });

    it("serves an explicit status=ACTIVE request", async () => {
      campaignDelegate.findMany.mockResolvedValue([row(), row({ id: "cmp_2" })]);

      const result = await service.findAll(CampaignStatus.ACTIVE, editor);

      expect(campaignDelegate.findMany).toHaveBeenCalledWith({
        where: { active: true, status: CampaignStatus.ACTIVE },
        orderBy: { createdAt: "desc" },
      });
      expect(result).toHaveLength(2);
    });

    it("rejects status=INACTIVE rather than quietly answering with ACTIVE rows", async () => {
      // Returning ACTIVE rows for an INACTIVE query would be a contract the
      // client cannot tell is a lie, so this is a 403 and not a narrowed read.
      await expect(
        service.findAll(CampaignStatus.INACTIVE, editor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(campaignDelegate.findMany).not.toHaveBeenCalled();
    });
  });

  describe("findOne as an admin", () => {
    it("scopes the lookup to active rows", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());

      await service.findOne("cmp_1", admin);

      expect(campaignDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: "cmp_1", active: true },
      });
    });

    it("throws NotFoundException for a soft-deleted id", async () => {
      // A soft-deleted row is filtered out by the where clause, so the
      // delegate resolves null exactly as it would for an unknown id.
      campaignDelegate.findFirst.mockResolvedValue(null);

      await expect(service.findOne("cmp_deleted", admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("returns an INACTIVE campaign, which only editors are scoped out of", async () => {
      const inactive = row({ status: CampaignStatus.INACTIVE });
      campaignDelegate.findFirst.mockResolvedValue(inactive);

      await expect(service.findOne("cmp_1", admin)).resolves.toBe(inactive);
    });
  });

  describe("findOne as an editor", () => {
    it("returns an ACTIVE campaign", async () => {
      const active = row();
      campaignDelegate.findFirst.mockResolvedValue(active);

      await expect(service.findOne("cmp_1", editor)).resolves.toBe(active);
    });

    it("throws NotFoundException — not Forbidden — for an INACTIVE campaign", async () => {
      campaignDelegate.findFirst.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE }),
      );

      const rejection = service.findOne("cmp_1", editor);

      // A 403 would confirm the id exists. The response must be the same 404,
      // message included, that an unknown or soft-deleted id produces.
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await expect(rejection).rejects.not.toBeInstanceOf(ForbiddenException);
      await expect(rejection).rejects.toThrowError("Campaign cmp_1 not found");
    });

    it("throws NotFoundException for a soft-deleted id", async () => {
      campaignDelegate.findFirst.mockResolvedValue(null);

      await expect(
        service.findOne("cmp_deleted", editor),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("update", () => {
    it("writes only the supplied fields and leaves active untouched", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      campaignDelegate.update.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE }),
      );

      await service.update("cmp_1", { status: CampaignStatus.INACTIVE });

      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { status: CampaignStatus.INACTIVE },
      });
    });

    it("clears a nullable field when it is explicitly null", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      campaignDelegate.update.mockResolvedValue(row());

      await service.update("cmp_1", { briefText: null });

      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { briefText: null },
      });
    });

    it("re-resolves the name when the tracker id changes", async () => {
      campaignDelegate.findFirst.mockResolvedValue(
        row({ trackerCampaignId: "trk-1", trackerCampaignName: "Ikkis" }),
      );
      trackerMock.resolveName.mockResolvedValue("Airbnb");
      campaignDelegate.update.mockResolvedValue(
        row({ trackerCampaignId: "trk-2", trackerCampaignName: "Airbnb" }),
      );

      await service.update("cmp_1", { trackerCampaignId: "trk-2" });

      expect(trackerMock.resolveName).toHaveBeenCalledWith("trk-2");
      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { trackerCampaignId: "trk-2", trackerCampaignName: "Airbnb" },
      });
    });

    it("clears both tracker columns when the id is explicitly null", async () => {
      campaignDelegate.findFirst.mockResolvedValue(
        row({ trackerCampaignId: "trk-1", trackerCampaignName: "Ikkis" }),
      );
      campaignDelegate.update.mockResolvedValue(row());

      await service.update("cmp_1", { trackerCampaignId: null });

      // Unlinking must not leave the old label orphaned on the row.
      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { trackerCampaignId: null, trackerCampaignName: null },
      });
      expect(trackerMock.resolveName).not.toHaveBeenCalled();
    });

    it("rejects an unknown tracker id without writing", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      trackerMock.resolveName.mockResolvedValue(null);

      await expect(
        service.update("cmp_1", { trackerCampaignId: "trk-gone" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(campaignDelegate.update).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a soft-deleted id without writing", async () => {
      campaignDelegate.findFirst.mockResolvedValue(null);

      await expect(
        service.update("cmp_deleted", { title: "New title" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(campaignDelegate.update).not.toHaveBeenCalled();
    });

    it("still runs its 404-before-write check through the soft-delete lookup", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      campaignDelegate.update.mockResolvedValue(row({ title: "New title" }));

      await service.update("cmp_1", { title: "New title" });

      expect(campaignDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: "cmp_1", active: true },
      });
    });

    it("patches an INACTIVE campaign — the editor read rule must not reach writes", async () => {
      campaignDelegate.findFirst.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE }),
      );
      campaignDelegate.update.mockResolvedValue(row());

      await service.update("cmp_1", { status: CampaignStatus.ACTIVE });

      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { status: CampaignStatus.ACTIVE },
      });
    });
  });

  describe("remove", () => {
    it("soft deletes by setting active=false instead of deleting the row", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      campaignDelegate.update.mockResolvedValue(row({ active: false }));

      const result = await service.remove("cmp_1");

      expect(campaignDelegate.update).toHaveBeenCalledWith({
        where: { id: "cmp_1" },
        data: { active: false },
      });
      expect(campaignDelegate.delete).not.toHaveBeenCalled();
      expect(result.active).toBe(false);
      // status is business state and must survive a delete untouched.
      expect(result.status).toBe(CampaignStatus.ACTIVE);
    });

    it("throws NotFoundException for an already soft-deleted id", async () => {
      campaignDelegate.findFirst.mockResolvedValue(null);

      await expect(service.remove("cmp_deleted")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(campaignDelegate.update).not.toHaveBeenCalled();
    });

    it("still runs its 404-before-write check through the soft-delete lookup", async () => {
      campaignDelegate.findFirst.mockResolvedValue(row());
      campaignDelegate.update.mockResolvedValue(row({ active: false }));

      await service.remove("cmp_1");

      expect(campaignDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: "cmp_1", active: true },
      });
    });

    it("soft deletes an INACTIVE campaign — the editor read rule must not reach writes", async () => {
      campaignDelegate.findFirst.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE }),
      );
      campaignDelegate.update.mockResolvedValue(
        row({ status: CampaignStatus.INACTIVE, active: false }),
      );

      const result = await service.remove("cmp_1");

      expect(result.active).toBe(false);
      expect(result.status).toBe(CampaignStatus.INACTIVE);
    });
  });
});
