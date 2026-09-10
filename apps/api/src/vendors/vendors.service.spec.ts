import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Vendor } from "@repo/database";
import type { PrismaService } from "../prisma/prisma.service.js";
import { VendorsService } from "./vendors.service.js";

/**
 * The service is constructed by hand against a mock `prisma.client.vendor`, so
 * these tests need neither a Nest DI container nor a database.
 */
function createMocks() {
  const vendor = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const service = new VendorsService({
    client: { vendor },
  } as unknown as PrismaService);
  return { service, vendor };
}

function makeVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: "v1",
    name: "Asha Rao",
    email: "asha@example.com",
    phoneNumber: "9876543210",
    instagram: null,
    twitter: null,
    linkedin: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

let mocks: ReturnType<typeof createMocks>;

beforeEach(() => {
  mocks = createMocks();
});

describe("VendorsService.findAll", () => {
  it("lists every vendor, newest first, when no filter is given", async () => {
    const rows = [makeVendor()];
    mocks.vendor.findMany.mockResolvedValue(rows);

    await expect(mocks.service.findAll()).resolves.toBe(rows);
    // No `active` clause at all: inactive vendors are a visible status here,
    // not a soft delete, so the default list includes them.
    expect(mocks.vendor.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters on active when asked for active vendors", async () => {
    mocks.vendor.findMany.mockResolvedValue([]);

    await mocks.service.findAll(true);

    expect(mocks.vendor.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { createdAt: "desc" },
    });
  });

  it("filters on active when asked for inactive vendors", async () => {
    mocks.vendor.findMany.mockResolvedValue([]);

    await mocks.service.findAll(false);

    expect(mocks.vendor.findMany).toHaveBeenCalledWith({
      where: { active: false },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("VendorsService.findOne", () => {
  it("looks a vendor up by id alone", async () => {
    const row = makeVendor();
    mocks.vendor.findUnique.mockResolvedValue(row);

    await expect(mocks.service.findOne("v1")).resolves.toBe(row);
    expect(mocks.vendor.findUnique).toHaveBeenCalledWith({
      where: { id: "v1" },
    });
  });

  it("returns an inactive vendor rather than hiding it", async () => {
    const row = makeVendor({ active: false });
    mocks.vendor.findUnique.mockResolvedValue(row);

    await expect(mocks.service.findOne("v1")).resolves.toBe(row);
  });

  it("throws NotFound when there is no such vendor", async () => {
    mocks.vendor.findUnique.mockResolvedValue(null);

    await expect(mocks.service.findOne("gone")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("VendorsService.create", () => {
  it("writes explicit nulls for omitted optionals and never sets active", async () => {
    mocks.vendor.findUnique.mockResolvedValue(null);
    const created = makeVendor();
    mocks.vendor.create.mockResolvedValue(created);

    await expect(
      mocks.service.create({ name: "Asha Rao", phoneNumber: "9876543210" }),
    ).resolves.toBe(created);

    expect(mocks.vendor.create).toHaveBeenCalledWith({
      data: {
        name: "Asha Rao",
        phoneNumber: "9876543210",
        email: null,
        instagram: null,
        twitter: null,
        linkedin: null,
      },
    });
  });

  it("throws Conflict when an active vendor already has that number", async () => {
    mocks.vendor.findUnique.mockResolvedValue(makeVendor({ active: true }));

    const attempt = () =>
      mocks.service.create({ name: "Someone Else", phoneNumber: "9876543210" });

    await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt()).rejects.toThrow(/\(active\)/);
    expect(mocks.vendor.create).not.toHaveBeenCalled();
  });

  it("refuses to revive an inactive vendor, and says how to bring them back", async () => {
    mocks.vendor.findUnique.mockResolvedValue(makeVendor({ active: false }));

    const attempt = () =>
      mocks.service.create({ name: "Asha Rao", phoneNumber: "9876543210" });

    await expect(attempt()).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt()).rejects.toThrow(/inactive/);
    // Unlike users, POST never revives: the row stays exactly as it was and
    // re-activating is an explicit action in the Vendors list.
    expect(mocks.vendor.create).not.toHaveBeenCalled();
    expect(mocks.vendor.update).not.toHaveBeenCalled();
  });
});

describe("VendorsService.update", () => {
  it("sends only the submitted keys", async () => {
    const target = makeVendor();
    mocks.vendor.findUnique.mockResolvedValue(target);
    const updated = makeVendor({ name: "Asha R." });
    mocks.vendor.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("v1", { name: "Asha R." }),
    ).resolves.toBe(updated);
    expect(mocks.vendor.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { name: "Asha R." },
    });
  });

  it("clears a nullable field when null is submitted", async () => {
    const target = makeVendor();
    mocks.vendor.findUnique.mockResolvedValue(target);
    const updated = makeVendor({ email: null });
    mocks.vendor.update.mockResolvedValue(updated);

    await expect(mocks.service.update("v1", { email: null })).resolves.toBe(
      updated,
    );
    expect(mocks.vendor.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { email: null },
    });
  });

  it("passes the status toggle through", async () => {
    const target = makeVendor();
    mocks.vendor.findUnique.mockResolvedValue(target);
    const updated = makeVendor({ active: false });
    mocks.vendor.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("v1", { active: false }),
    ).resolves.toBe(updated);
    expect(mocks.vendor.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { active: false },
    });
  });

  it("throws NotFound for a vendor that does not exist", async () => {
    mocks.vendor.findUnique.mockResolvedValue(null);

    await expect(
      mocks.service.update("gone", { name: "Nope" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mocks.vendor.update).not.toHaveBeenCalled();
  });

  it("throws Conflict when the new number belongs to another vendor", async () => {
    mocks.vendor.findUnique
      .mockResolvedValueOnce(makeVendor())
      .mockResolvedValueOnce(makeVendor({ id: "v2", phoneNumber: "9000000001" }));

    await expect(
      mocks.service.update("v1", { phoneNumber: "9000000001" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.vendor.update).not.toHaveBeenCalled();
  });

  it("does not probe for a clash when the number is unchanged", async () => {
    const target = makeVendor();
    mocks.vendor.findUnique.mockResolvedValue(target);
    mocks.vendor.update.mockResolvedValue(target);

    await expect(
      mocks.service.update("v1", { phoneNumber: target.phoneNumber }),
    ).resolves.toBe(target);
    // One call: the existence check. No uniqueness probe was needed.
    expect(mocks.vendor.findUnique).toHaveBeenCalledTimes(1);
  });
});
