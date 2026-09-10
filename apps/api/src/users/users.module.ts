import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller.js";
import { UsersService } from "./users.service.js";

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  // Exported so other feature modules can look users up without reimplementing
  // the active-only filtering rules.
  exports: [UsersService],
})
export class UsersModule {}
