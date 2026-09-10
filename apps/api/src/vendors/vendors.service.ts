import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma, Vendor } from "@repo/database";
import { PrismaService } from "../prisma/prisma.service.js";
import type { CreateVendorDto } from "./dto/create-vendor.dto.js";
import type { UpdateVendorDto } from "./dto/update-vendor.dto.js";

/**
 * Vendor directory CRUD.
 *
 * `Vendor.active` looks like the soft-delete flag on User and Campaign but is
 * deliberately the opposite kind of thing: a visible status. Inactive vendors
 * stay in the list, stay reachable by id, and are re-activated with a PATCH.
 * There is no delete endpoint at all, which is why create refuses to revive a
 * number rather than quietly resurrecting a row the admin cannot see.
 *
 * `phoneNumber` is the identity of a vendor. It is @unique in the database and
 * normalised in the DTO, so POST, PATCH and bulk import all agree on what a
 * duplicate is without having to coordinate.
 */
@Injectable()
export class VendorsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Vendors, newest first. With no filter this returns inactive rows too —
   * hiding them would make the status toggle look like a delete.
   */
  findAll(active?: boolean): Promise<Vendor[]> {
    const where: Prisma.VendorWhereInput = {};
    if (active !== undefined) {
      where.active = active;
    }
    return this.prisma.client.vendor.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  }

  /** One vendor by id. Inactive rows are returned like any other. */
  async findOne(id: string): Promise<Vendor> {
    const vendor = await this.prisma.client.vendor.findUnique({
      where: { id },
    });
    if (!vendor) {
      throw new NotFoundException(`Vendor ${id} not found`);
    }
    return vendor;
  }

  /**
   * Create a vendor.
   *
   * A number that is already taken is a 409 either way, but the two messages
   * differ: an inactive match is a row the admin can see and re-activate, so
   * saying so is more useful than "already exists". Nothing is written in
   * either case — unlike users, this endpoint never revives.
   */
  async create(dto: CreateVendorDto): Promise<Vendor> {
    const existing = await this.prisma.client.vendor.findUnique({
      where: { phoneNumber: dto.phoneNumber },
    });

    if (existing) {
      throw new ConflictException(
        existing.active
          ? `A vendor with phone number ${dto.phoneNumber} already exists (active).`
          : `A vendor with phone number ${dto.phoneNumber} already exists but ` +
            `is inactive — re-activate it from the Vendors list instead of ` +
            `creating a new one.`,
      );
    }

    return this.prisma.client.vendor.create({
      // Explicit nulls rather than undefined, so an omitted optional is stored
      // as "no value" instead of relying on Prisma's undefined handling.
      data: {
        name: dto.name,
        phoneNumber: dto.phoneNumber,
        email: dto.email ?? null,
        instagram: dto.instagram ?? null,
        twitter: dto.twitter ?? null,
        linkedin: dto.linkedin ?? null,
      },
    });
  }

  /**
   * Partial update. Only the submitted keys are written, so a field that was
   * not mentioned cannot be blanked by accident.
   */
  async update(id: string, dto: UpdateVendorDto): Promise<Vendor> {
    const vendor = await this.findOne(id);

    if (dto.phoneNumber !== undefined && dto.phoneNumber !== vendor.phoneNumber) {
      // Checked up front so the caller gets a 409 with a clear message rather
      // than a raw unique-constraint failure. Skipped when the number did not
      // change, which is the common case for an edit.
      const clash = await this.prisma.client.vendor.findUnique({
        where: { phoneNumber: dto.phoneNumber },
      });
      if (clash && clash.id !== vendor.id) {
        throw new ConflictException(
          `Another vendor already uses the phone number ${dto.phoneNumber}.`,
        );
      }
    }

    const data: Prisma.VendorUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.phoneNumber !== undefined) data.phoneNumber = dto.phoneNumber;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.instagram !== undefined) data.instagram = dto.instagram;
    if (dto.twitter !== undefined) data.twitter = dto.twitter;
    if (dto.linkedin !== undefined) data.linkedin = dto.linkedin;
    if (dto.active !== undefined) data.active = dto.active;

    return this.prisma.client.vendor.update({ where: { id: vendor.id }, data });
  }
}
