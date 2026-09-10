import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { Role, type Campaign } from "@repo/database";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CampaignsService } from "./campaigns.service.js";
import { CreateCampaignDto } from "./dto/create-campaign.dto.js";
import { ListCampaignsQueryDto } from "./dto/list-campaigns-query.dto.js";
import { UpdateCampaignDto } from "./dto/update-campaign.dto.js";

/**
 * Campaigns. Split by role per route rather than per controller: the admin
 * restriction sits on create, update and remove only, so editors can list and
 * open campaigns — which is how they pick up work — but cannot change them.
 * There is no class-level restriction, and RolesGuard resolves the decorator
 * per handler, so the two read routes are open to any authenticated caller;
 * the globally registered JwtAuthGuard has already rejected anonymous ones.
 *
 * What an editor may *see* is decided in the service, not here: it scopes
 * their reads to status=ACTIVE.
 */
@Controller("campaigns")
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  /**
   * GET /api/campaigns?status=ACTIVE|INACTIVE — active campaigns, newest
   * first. Editors always get ACTIVE ones; status=INACTIVE is a 403 for them.
   */
  @Get()
  findAll(
    @Query() query: ListCampaignsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Campaign[]> {
    return this.campaignsService.findAll(query.status, user);
  }

  /** GET /api/campaigns/:id — 404 for an editor if the campaign is INACTIVE. */
  @Get(":id")
  findOne(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Campaign> {
    return this.campaignsService.findOne(id, user);
  }

  /** POST /api/campaigns */
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() body: CreateCampaignDto): Promise<Campaign> {
    return this.campaignsService.create(body);
  }

  /** PATCH /api/campaigns/:id */
  @Patch(":id")
  @Roles(Role.ADMIN)
  update(
    @Param("id") id: string,
    @Body() body: UpdateCampaignDto,
  ): Promise<Campaign> {
    return this.campaignsService.update(id, body);
  }

  /** DELETE /api/campaigns/:id — soft delete; returns the updated row. */
  @Delete(":id")
  @Roles(Role.ADMIN)
  remove(@Param("id") id: string): Promise<Campaign> {
    return this.campaignsService.remove(id);
  }
}
