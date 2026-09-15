import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CampaignStatus,
  Role,
  type Campaign,
  type Prisma,
} from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TrackerService } from "../tracker/tracker.service.js";
import type { CreateCampaignDto } from "./dto/create-campaign.dto.js";
import type { UpdateCampaignDto } from "./dto/update-campaign.dto.js";

/**
 * Campaign CRUD.
 *
 * Two flags that are easy to confuse are kept strictly apart here:
 *   - `active`  — soft-delete flag. false means deleted; such rows are hidden
 *                 from every read and a delete only ever flips this to false.
 *   - `status`  — business state (ACTIVE / INACTIVE). A paused campaign is
 *                 status=INACTIVE while still active=true, and stays listable.
 *
 * Reads are role-scoped, because the controller lets editors reach them: an
 * admin sees every non-deleted campaign, an editor only ever sees status=ACTIVE
 * ones. That rule lives here rather than in the controller so there is exactly
 * one place it can be got wrong. `user` is a required parameter on both read
 * methods on purpose — an optional one would silently default a forgotten call
 * site into the permissive branch.
 *
 * The tracker link is likewise two columns that must agree:
 * `trackerCampaignId` is what the client picks, `trackerCampaignName` is the
 * denormalised display name. The name is never taken from the request body —
 * it is resolved from the id here, so the pair cannot drift apart.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tracker: TrackerService,
  ) {}

  /**
   * Active (non-deleted) campaigns, newest first, optionally narrowed to one
   * business status. Editors are pinned to status=ACTIVE.
   */
  async findAll(
    status: CampaignStatus | undefined,
    user: AuthenticatedUser,
  ): Promise<Campaign[]> {
    const where: Prisma.CampaignWhereInput = { active: true };

    if (user.role === Role.ADMIN) {
      if (status !== undefined) {
        where.status = status;
      }
    } else {
      // An editor asking for anything but ACTIVE is refused rather than
      // quietly served the ACTIVE rows: answering an INACTIVE query with rows
      // that are all ACTIVE is a contract the client cannot tell is a lie.
      // Omitting the filter is fine — it means "whatever I may see".
      if (status !== undefined && status !== CampaignStatus.ACTIVE) {
        throw new ForbiddenException("Editors can only list ACTIVE campaigns");
      }
      where.status = CampaignStatus.ACTIVE;
    }

    return this.prisma.client.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  }

  /** One active campaign. Soft-deleted ids are 404, same as unknown ones. */
  async findOne(id: string, user: AuthenticatedUser): Promise<Campaign> {
    const campaign = await this.getActiveOrThrow(id);

    // A campaign outside the editor scope must be indistinguishable from one
    // that does not exist. A 403 here would confirm the id is real, so an
    // INACTIVE row 404s for them exactly as a soft-deleted one does.
    if (user.role !== Role.ADMIN && campaign.status !== CampaignStatus.ACTIVE) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }

    return campaign;
  }

  /** Creates a campaign. `status` defaults to ACTIVE; `active` starts true. */
  async create(input: CreateCampaignDto): Promise<Campaign> {
    const trackerCampaignId = input.trackerCampaignId ?? null;
    // Resolved before the insert, so an unknown id is a 400 and not a row
    // carrying a tracker link nobody can display.
    const trackerCampaignName =
      trackerCampaignId === null
        ? null
        : await this.resolveTrackerName(trackerCampaignId);

    return this.prisma.client.campaign.create({
      data: {
        title: input.title,
        briefText: input.briefText ?? null,
        guidanceNote: input.guidanceNote ?? null,
        trackerCampaignId,
        trackerCampaignName,
        status: input.status ?? CampaignStatus.ACTIVE,
        // Omitted leaves the column default (90) in place.
        ...(input.duplicationThreshold === undefined
          ? {}
          : { duplicationThreshold: input.duplicationThreshold }),
      },
    });
  }

  /**
   * Patches an existing active campaign. Only the keys present in the body
   * are written, so an omitted field keeps its stored value while an explicit
   * null clears a nullable one.
   */
  async update(id: string, input: UpdateCampaignDto): Promise<Campaign> {
    // 404 before writing, and it keeps soft-deleted rows unpatchable.
    await this.getActiveOrThrow(id);

    const data: Prisma.CampaignUpdateInput = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.briefText !== undefined) data.briefText = input.briefText;
    if (input.guidanceNote !== undefined) data.guidanceNote = input.guidanceNote;
    if (input.trackerCampaignId !== undefined) {
      // Both tracker columns move together: unlinking clears the name too,
      // rather than leaving an orphaned label behind.
      data.trackerCampaignId = input.trackerCampaignId;
      data.trackerCampaignName =
        input.trackerCampaignId === null
          ? null
          : await this.resolveTrackerName(input.trackerCampaignId);
    }
    if (input.status !== undefined) data.status = input.status;
    if (input.duplicationThreshold !== undefined) {
      data.duplicationThreshold = input.duplicationThreshold;
    }
    if (input.active !== undefined) data.active = input.active;

    return this.prisma.client.campaign.update({ where: { id }, data });
  }

  /**
   * Soft delete: flips `active` to false and returns the updated row. Rows are
   * never physically removed, and `status` is left exactly as it was.
   */
  async remove(id: string): Promise<Campaign> {
    await this.getActiveOrThrow(id);
    return this.prisma.client.campaign.update({
      where: { id },
      data: { active: false },
    });
  }

  /**
   * The soft-delete-aware lookup, shared by findOne and by the write paths.
   *
   * It deliberately carries no role scoping. update and remove are admin-only
   * routes doing a 404-before-write check, and folding the editor rule in here
   * would quietly change what a write is allowed to reach; the public findOne
   * layers that scoping on top instead.
   */
  private async getActiveOrThrow(id: string): Promise<Campaign> {
    // findFirst, not findUnique: the soft-delete flag is part of the lookup,
    // so a deleted row must not be findable by id.
    const campaign = await this.prisma.client.campaign.findFirst({
      where: { id, active: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${id} not found`);
    }
    return campaign;
  }

  /**
   * Display name for a tracker id, rejecting ids the tracker does not know.
   *
   * The client sends only the id. Accepting a name alongside it would let a
   * stale form persist a label that never matched the id it was stored with,
   * so the name is looked up server-side instead.
   */
  private async resolveTrackerName(trackerCampaignId: string): Promise<string> {
    const name = await this.tracker.resolveName(trackerCampaignId);
    if (name === null) {
      throw new BadRequestException(
        `Unknown tracker campaign id: ${trackerCampaignId}`,
      );
    }
    return name;
  }
}
