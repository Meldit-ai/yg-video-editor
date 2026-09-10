import { Module } from "@nestjs/common";
import { VendorsController } from "./vendors.controller.js";
import { VendorsService } from "./vendors.service.js";
import { VendorImportParser } from "./import/vendor-import.parser.js";
import { VendorImportService } from "./import/vendor-import.service.js";

// PrismaModule is global, so it does not need importing here.
@Module({
  controllers: [VendorsController],
  providers: [VendorsService, VendorImportParser, VendorImportService],
})
export class VendorsModule {}
