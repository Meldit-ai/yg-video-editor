import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Role, type Vendor } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { VendorsService } from "./vendors.service.js";
import { CreateVendorDto } from "./dto/create-vendor.dto.js";
import { UpdateVendorDto } from "./dto/update-vendor.dto.js";
import { ListVendorsQueryDto } from "./dto/list-vendors-query.dto.js";
import { VendorImportService } from "./import/vendor-import.service.js";
import {
  MAX_IMPORT_FILE_BYTES,
  TEMPLATE_FILE_NAME,
  XLSX_MIME,
} from "./import/vendor-import.columns.js";
import type {
  UploadedSpreadsheet,
  VendorImportResult,
} from "./import/vendor-import.types.js";

/**
 * The vendor directory. Admin-only in its entirety: these are the contacts the
 * team works with, not accounts, and only admins curate them.
 *
 * There is no @Delete here on purpose. A vendor is deactivated through PATCH
 * and stays visible; nothing removes a row.
 */
@Controller("vendors")
@Roles(Role.ADMIN)
export class VendorsController {
  constructor(
    private readonly vendorsService: VendorsService,
    private readonly importService: VendorImportService,
  ) {}

  /** GET /api/vendors?active=true|false — inactive vendors included by default. */
  @Get()
  findAll(@Query() query: ListVendorsQueryDto): Promise<Vendor[]> {
    return this.vendorsService.findAll(query.active);
  }

  /**
   * GET /api/vendors/import/template — the blank .xlsx to fill in.
   *
   * Declared before the :id route: Nest matches in declaration order, and
   * "import" would otherwise be read as a vendor id.
   */
  @Get("import/template")
  async downloadTemplate(): Promise<StreamableFile> {
    const buffer = await this.importService.buildTemplate();
    return new StreamableFile(buffer, {
      type: XLSX_MIME,
      disposition: `attachment; filename="${TEMPLATE_FILE_NAME}"`,
      length: buffer.length,
    });
  }

  /**
   * POST /api/vendors/import — multipart, field "file".
   *
   * 200 rather than 201: a run that creates nothing because every row was a
   * duplicate is still a successful import, and the body says what happened.
   *
   * Memory storage (the multer default) is what puts the workbook in
   * file.buffer. No FileTypeValidator: it sniffs magic bytes, and an .xlsx is
   * a zip, so the extension check in the service is the honest one.
   */
  @Post("import")
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 },
      // Keeps a non-ASCII file name readable when it is echoed back.
      defParamCharset: "utf8",
    }),
  )
  import(
    @UploadedFile() file: UploadedSpreadsheet | undefined,
  ): Promise<VendorImportResult> {
    return this.importService.importFile(file);
  }

  /** GET /api/vendors/:id — 404 if there is no such vendor. */
  @Get(":id")
  findOne(@Param("id") id: string): Promise<Vendor> {
    return this.vendorsService.findOne(id);
  }

  /** POST /api/vendors — body: { name, phoneNumber, email?, socials? }. */
  @Post()
  create(@Body() dto: CreateVendorDto): Promise<Vendor> {
    return this.vendorsService.create(dto);
  }

  /** PATCH /api/vendors/:id — every field optional, including `active`. */
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateVendorDto,
  ): Promise<Vendor> {
    return this.vendorsService.update(id, dto);
  }
}
