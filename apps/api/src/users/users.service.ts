import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role, type User } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { CreateUserDto } from "./dto/create-user.dto.js";
import type { UpdateUserDto } from "./dto/update-user.dto.js";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reconcile a submitted rate card with the role it will be stored against.
   *
   * The rate card is what an editor charges per video, so it only means
   * anything on an EDITOR row. Deriving the stored value from the *effective*
   * role rather than trusting the payload keeps the two in step by
   * construction: promoting an editor to ADMIN clears the rate, and a rate
   * sent for an admin is a visible 400 rather than a value quietly written
   * where nothing will ever read it.
   *
   * `undefined` means "leave it alone" — Prisma ignores it in an update
   * payload — and `null` clears it.
   */
  private resolveRateCard(
    role: Role,
    rateCard: number | null | undefined,
  ): number | null | undefined {
    if (role !== Role.ADMIN) return rateCard;

    if (rateCard !== undefined && rateCard !== null) {
      throw new BadRequestException(
        "rateCard applies to EDITOR users only. Remove it, or set the role to EDITOR.",
      );
    }
    // Not merely "leave alone": a promoted editor must not keep a stale rate.
    return null;
  }

  /** Active users, newest first. Soft-deleted rows are never listed. */
  findAll(): Promise<User[]> {
    return this.prisma.client.user.findMany({
      where: { active: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * One active user. A soft-deleted row is treated exactly like a missing one
   * so deletion is not observable through this endpoint.
   */
  async findOne(id: string): Promise<User> {
    const user = await this.prisma.client.user.findFirst({
      where: { id, active: true },
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  /**
   * Create a user, or revive a soft-deleted one.
   *
   * `mobile` is unique across every row, deleted or not, so a plain create
   * would fail with a unique-constraint error for a number that once belonged
   * to a deleted account. Since there is no signup flow, an admin re-adding a
   * number must mean "this person is back": the existing row is reactivated
   * with the submitted name and role, keeping its id and history.
   */
  async create(dto: CreateUserDto): Promise<User> {
    const role = dto.role ?? Role.EDITOR;
    // `?? null` so a revived row is written from the submitted values alone,
    // rather than inheriting the rate from the account's previous life.
    const rateCard = this.resolveRateCard(role, dto.rateCard) ?? null;
    const existing = await this.prisma.client.user.findUnique({
      where: { mobile: dto.mobile },
    });

    if (existing) {
      if (existing.active) {
        throw new ConflictException(
          `A user with mobile ${dto.mobile} already exists`,
        );
      }
      return this.prisma.client.user.update({
        where: { id: existing.id },
        data: { name: dto.name, role, rateCard, active: true },
      });
    }

    return this.prisma.client.user.create({
      data: { mobile: dto.mobile, name: dto.name, role, rateCard },
    });
  }

  /**
   * Partial update. Guards against an admin locking themselves out: with no
   * signup and no self-service recovery, demoting or deactivating your own
   * account is unrecoverable without direct database access.
   */
  async update(
    id: string,
    dto: UpdateUserDto,
    currentUser: AuthenticatedUser,
  ): Promise<User> {
    const user = await this.findOne(id);
    const isSelf = currentUser.id === user.id;

    if (isSelf && dto.role !== undefined && dto.role !== Role.ADMIN) {
      throw new BadRequestException(
        "You cannot change your own role away from ADMIN. Ask another admin to do it.",
      );
    }
    if (isSelf && dto.active === false) {
      throw new BadRequestException(
        "You cannot deactivate your own account. Ask another admin to do it.",
      );
    }

    // Resolved against the role the row will *end up* with, so promoting an
    // editor in the same request that omits the rate still clears it.
    const rateCard = this.resolveRateCard(dto.role ?? user.role, dto.rateCard);

    if (dto.mobile !== undefined && dto.mobile !== user.mobile) {
      // Checked up front so the caller gets a 409 with a clear message rather
      // than a raw unique-constraint failure. The clash may be a soft-deleted
      // row: the number is still taken, and reviving it is POST's job.
      const clash = await this.prisma.client.user.findUnique({
        where: { mobile: dto.mobile },
      });
      if (clash && clash.id !== user.id) {
        throw new ConflictException(
          `A user with mobile ${dto.mobile} already exists`,
        );
      }
    }

    return this.prisma.client.user.update({
      where: { id: user.id },
      // Prisma ignores `undefined` fields, so omitted keys stay untouched.
      data: {
        mobile: dto.mobile,
        name: dto.name,
        role: dto.role,
        rateCard,
        active: dto.active,
      },
    });
  }

  /**
   * Soft delete: flips `active` to false and returns the updated row. Rows are
   * never removed — user ids are referenced elsewhere and history must survive.
   */
  async remove(id: string, currentUser: AuthenticatedUser): Promise<User> {
    if (currentUser.id === id) {
      throw new BadRequestException(
        "You cannot delete your own account. Ask another admin to do it.",
      );
    }
    const user = await this.findOne(id);
    return this.prisma.client.user.update({
      where: { id: user.id },
      data: { active: false },
    });
  }
}
