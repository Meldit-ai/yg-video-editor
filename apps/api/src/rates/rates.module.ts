import { Module } from "@nestjs/common";
import { RatesController } from "./rates.controller.js";
import { RatesService } from "./rates.service.js";

@Module({
  controllers: [RatesController],
  providers: [RatesService],
  // The dashboard prices submissions with the same resolution order.
  exports: [RatesService],
})
export class RatesModule {}
