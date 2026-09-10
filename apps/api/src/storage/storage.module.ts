import { Module } from "@nestjs/common";
import { StorageService } from "./storage.service.js";

/**
 * Object storage (Hetzner, over the S3 API). Holds no controllers: nothing is
 * routed here, it is a dependency of whatever feature needs to store bytes.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
