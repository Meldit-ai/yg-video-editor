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
import type { Page } from "../common/pagination.js";
import { UploadSizeGuard } from "./guards/upload-size.guard.js";
import { VIDEO_FIELD_NAME } from "./submissions.constants.js";
import { MatchesService } from "../matches/matches.service.js";
import type { EditorPostedVideoDto } from "../matches/matches.types.js";
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
  constructor(
    private readonly submissions: SubmissionsService,
    private readonly matches: MatchesService,
  ) {}

  /**
   * GET /api/campaigns/:campaignId/submissions — newest first by default.
   *
   * `?sort=original` is the campaign feed's ordering (least duplicated at the
   * top); `?flagged=true` narrows it to videos that met the campaign's
   * accepted-duplication level. `?take=` and `?skip=` read one page of the
   * result; without `take` the whole list comes back, as it always did.
   *
   * Answers a page envelope either way, so a caller reads `items` and `total`
   * without having to know whether it asked for a page.
   */
  @Get()
  findAll(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListSubmissionsQueryDto,
  ): Promise<Page<VideoSubmissionDto>> {
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
   * GET .../submissions/posted — the caller's own videos that reached
   * Instagram, and what they earned there.
   *
   * Lives here rather than under /matches because that controller is
   * @Roles(ADMIN): it names creators across a whole campaign. This returns
   * only the caller's own work, in a shape that says nothing about how the
   * match was made — no tracker ids, no hashes, no duplication verdicts.
   *
   * An admin calling it sees their own submissions, which is usually none.
   */
  @Get("posted")
  posted(
    @Param("campaignId") campaignId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<EditorPostedVideoDto[]> {
    return this.matches.findForEditor(campaignId, user.id);
  }

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

  /**
   * DELETE /api/campaigns/:campaignId/submissions/:submissionId — soft delete;
   * returns the withdrawn row. The video file itself stays in storage.
   */
  @Delete(":submissionId")
  remove(
    @Param("campaignId") campaignId: string,
    @Param("submissionId") submissionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<VideoSubmissionDto> {
    return this.submissions.remove(campaignId, submissionId, user);
  }
}
