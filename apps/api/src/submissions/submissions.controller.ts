import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ListSubmissionsQueryDto } from "./dto/list-submissions-query.dto.js";
import { RenameSubmissionDto } from "./dto/rename-submission.dto.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { CampaignAccessGuard } from "../campaigns/guards/campaign-access.guard.js";
import { UploadSizeGuard } from "./guards/upload-size.guard.js";
import { VIDEO_FIELD_NAME } from "./submissions.constants.js";
import { SubmissionsService } from "./submissions.service.js";
import type { UploadedVideo, VideoSubmissionDto } from "./submissions.types.js";

/**
 * Video submissions, nested under the campaign they belong to.
 *
 * Open to every authenticated role, unlike most write routes: submitting work
 * is the editor's job, and the service decides what each role may see (an
 * editor only their own uploads, an admin all of them).
 *
 * CampaignAccessGuard sits on the class so it runs on every route — and,
 * crucially, before the upload interceptor, so a bad campaign id is rejected
 * before a video is streamed anywhere.
 */
@Controller("campaigns/:campaignId/submissions")
@UseGuards(CampaignAccessGuard)
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  /**
   * GET /api/campaigns/:campaignId/submissions — newest first by default.
   *
   * `?sort=original` is the campaign feed's ordering (least duplicated at the
   * top); `?flagged=true` narrows it to videos that met the campaign's
   * accepted-duplication level.
   */
  @Get()
  findAll(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSubmissionsQueryDto,
  ): Promise<VideoSubmissionDto[]> {
    return this.submissions.findAll(campaignId, user, query);
  }

  /**
   * POST /api/campaigns/:campaignId/submissions — multipart, field "file".
   *
   * The interceptor takes no options: they are registered module-wide by
   * MulterModule.registerAsync, because the storage engine needs the injected
   * StorageService to stream into the bucket. UploadSizeGuard sits in front of
   * it so an obviously over-sized request is refused before it is read.
   */
  @Post()
  @UseGuards(UploadSizeGuard)
  @UseInterceptors(FileInterceptor(VIDEO_FIELD_NAME))
  create(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedVideo | undefined,
  ): Promise<VideoSubmissionDto> {
    return this.submissions.create(campaignId, user, file);
  }

  /**
   * DELETE /api/campaigns/:campaignId/submissions/:submissionId — soft delete;
   * returns the withdrawn row. The video file itself stays in storage.
   */
  /**
   * PATCH /api/campaigns/:campaignId/submissions/:submissionId — rename.
   * An editor may rename their own; an admin any on the campaign.
   */
  @Patch(":submissionId")
  rename(
    @Param("campaignId") campaignId: string,
    @Param("submissionId") submissionId: string,
    @Body() dto: RenameSubmissionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoSubmissionDto> {
    return this.submissions.rename(
      campaignId,
      submissionId,
      dto.fileName,
      user,
    );
  }

  @Delete(":submissionId")
  remove(
    @Param("campaignId") campaignId: string,
    @Param("submissionId") submissionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoSubmissionDto> {
    return this.submissions.remove(campaignId, submissionId, user);
  }
}
