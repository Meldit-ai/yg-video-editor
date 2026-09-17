import { Controller, Get } from "@nestjs/common";
import { Role } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { SharesService } from "./shares.service.js";
import type { ShareableVendorDto } from "./shares.types.js";

/**
 * The vendor picker behind the share dialog.
 *
 * Separate from VendorsController because this is a different question: not
 * "who is in the directory" but "who can actually be messaged", with the
 * unreachable ones marked so an admin can see and fix them.
 */
@Controller("shareable-vendors")
@Roles(Role.ADMIN)
export class ShareableVendorsController {
  constructor(private readonly shares: SharesService) {}

  @Get()
  findAll(): Promise<ShareableVendorDto[]> {
    return this.shares.listShareableVendors();
  }
}
