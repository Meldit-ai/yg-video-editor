import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { Role, type User } from "@repo/database";
import { Roles } from "../auth/decorators/roles.decorator.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { UsersService } from "./users.service.js";
import { CreateUserDto } from "./dto/create-user.dto.js";
import { UpdateUserDto } from "./dto/update-user.dto.js";

/**
 * User administration. The whole controller is admin-only: this is the only
 * way accounts come into existence, so editors must not reach any of it.
 */
@Controller("users")
@Roles(Role.ADMIN)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** GET /api/users — active users, newest first. */
  @Get()
  findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  /** GET /api/users/:id — 404 if missing or soft-deleted. */
  @Get(":id")
  findOne(@Param("id") id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  /** POST /api/users — body: { mobile, name, role?, rateCard? }. */
  @Post()
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  /** PATCH /api/users/:id — body: { mobile?, name?, role?, rateCard?, active? }. */
  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<User> {
    return this.usersService.update(id, dto, currentUser);
  }

  /** DELETE /api/users/:id — soft delete; returns the updated row. */
  @Delete(":id")
  remove(
    @Param("id") id: string,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<User> {
    return this.usersService.remove(id, currentUser);
  }
}
