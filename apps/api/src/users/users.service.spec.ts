import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Role, type User } from "@repo/database";
import type { PrismaService } from "../prisma/prisma.service.js";
import { UsersService } from "./users.service.js";

/**
 * The service is constructed by hand against a mock `prisma.client.user`, so
 * these tests need neither a Nest DI container nor a database.
 */
function createMocks() {
  const user = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const service = new UsersService({
    client: { user },
  } as unknown as PrismaService);
  return { service, user };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u1",
    mobile: "9876543210",
    name: "Asha",
    role: Role.EDITOR,
    rateCard: null,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const admin = makeUser({
  id: "admin-1",
  mobile: "9000000000",
  role: Role.ADMIN,
});

let mocks: ReturnType<typeof createMocks>;

beforeEach(() => {
  mocks = createMocks();
});

describe("UsersService.findAll", () => {
  it("returns only active users, newest first", async () => {
    const rows = [makeUser()];
    mocks.user.findMany.mockResolvedValue(rows);

    await expect(mocks.service.findAll()).resolves.toBe(rows);
    expect(mocks.user.findMany).toHaveBeenCalledWith({
      where: { active: true },
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("UsersService.findOne", () => {
  it("filters on active when loading a single user", async () => {
    const row = makeUser();
    mocks.user.findFirst.mockResolvedValue(row);

    await expect(mocks.service.findOne("u1")).resolves.toBe(row);
    expect(mocks.user.findFirst).toHaveBeenCalledWith({
      where: { id: "u1", active: true },
    });
  });

  it("throws NotFound when the row is missing or soft-deleted", async () => {
    mocks.user.findFirst.mockResolvedValue(null);

    await expect(mocks.service.findOne("gone")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("UsersService.create", () => {
  it("creates a new user, defaulting the role to EDITOR", async () => {
    mocks.user.findUnique.mockResolvedValue(null);
    const created = makeUser();
    mocks.user.create.mockResolvedValue(created);

    await expect(
      mocks.service.create({ mobile: "9876543210", name: "Asha" }),
    ).resolves.toBe(created);
    expect(mocks.user.create).toHaveBeenCalledWith({
      data: {
        mobile: "9876543210",
        name: "Asha",
        role: Role.EDITOR,
        rateCard: null,
      },
    });
  });

  it("revives a soft-deleted user with the same mobile instead of failing", async () => {
    const deleted = makeUser({ id: "old-1", name: "Asha", active: false });
    mocks.user.findUnique.mockResolvedValue(deleted);
    const revived = makeUser({
      id: "old-1",
      name: "Asha Rao",
      role: Role.ADMIN,
    });
    mocks.user.update.mockResolvedValue(revived);

    await expect(
      mocks.service.create({
        mobile: "9876543210",
        name: "Asha Rao",
        role: Role.ADMIN,
      }),
    ).resolves.toBe(revived);

    expect(mocks.user.create).not.toHaveBeenCalled();
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "old-1" },
      data: {
        name: "Asha Rao",
        role: Role.ADMIN,
        rateCard: null,
        active: true,
      },
    });
  });

  it("throws Conflict when an active user already has that mobile", async () => {
    mocks.user.findUnique.mockResolvedValue(makeUser({ active: true }));

    await expect(
      mocks.service.create({ mobile: "9876543210", name: "Someone Else" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.user.create).not.toHaveBeenCalled();
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
});

describe("UsersService.update", () => {
  it("applies only the submitted fields", async () => {
    const target = makeUser();
    mocks.user.findFirst.mockResolvedValue(target);
    const updated = makeUser({ name: "Asha R." });
    mocks.user.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("u1", { name: "Asha R." }, admin),
    ).resolves.toBe(updated);
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        mobile: undefined,
        name: "Asha R.",
        role: undefined,
        rateCard: undefined,
        active: undefined,
      },
    });
  });

  it("throws NotFound for a soft-deleted target", async () => {
    mocks.user.findFirst.mockResolvedValue(null);

    await expect(
      mocks.service.update("gone", { name: "Nope" }, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("refuses to let an admin demote themselves out of ADMIN", async () => {
    mocks.user.findFirst.mockResolvedValue(admin);

    await expect(
      mocks.service.update(admin.id, { role: Role.EDITOR }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("refuses to let an admin deactivate themselves", async () => {
    mocks.user.findFirst.mockResolvedValue(admin);

    await expect(
      mocks.service.update(admin.id, { active: false }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("still lets an admin edit their own name and keep the ADMIN role", async () => {
    mocks.user.findFirst.mockResolvedValue(admin);
    const updated = makeUser({ ...admin, name: "Boss" });
    mocks.user.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update(admin.id, { name: "Boss", role: Role.ADMIN }, admin),
    ).resolves.toBe(updated);
  });

  it("lets an admin demote a different user", async () => {
    const other = makeUser({ id: "u2", role: Role.ADMIN });
    mocks.user.findFirst.mockResolvedValue(other);
    const updated = makeUser({ id: "u2", role: Role.EDITOR });
    mocks.user.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("u2", { role: Role.EDITOR }, admin),
    ).resolves.toBe(updated);
  });

  it("throws Conflict when the new mobile belongs to another user", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser());
    mocks.user.findUnique.mockResolvedValue(
      makeUser({ id: "u2", mobile: "9111111111" }),
    );

    await expect(
      mocks.service.update("u1", { mobile: "9111111111" }, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("allows resubmitting the same mobile unchanged", async () => {
    const target = makeUser();
    mocks.user.findFirst.mockResolvedValue(target);
    mocks.user.update.mockResolvedValue(target);

    await expect(
      mocks.service.update("u1", { mobile: target.mobile }, admin),
    ).resolves.toBe(target);
    // No uniqueness probe is needed when the number did not change.
    expect(mocks.user.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * The rate card is an editor's per-video fee, so the role and the rate have to
 * stay consistent: only an EDITOR carries one, and the server — not the
 * caller — is what guarantees that.
 */
describe("UsersService rate card", () => {
  it("stores the rate card when creating an editor", async () => {
    mocks.user.findUnique.mockResolvedValue(null);
    const created = makeUser({ rateCard: 1500 });
    mocks.user.create.mockResolvedValue(created);

    await expect(
      mocks.service.create({
        mobile: "9876543210",
        name: "Asha",
        role: Role.EDITOR,
        rateCard: 1500,
      }),
    ).resolves.toBe(created);
    expect(mocks.user.create).toHaveBeenCalledWith({
      data: {
        mobile: "9876543210",
        name: "Asha",
        role: Role.EDITOR,
        rateCard: 1500,
      },
    });
  });

  it("rejects a rate card for a new ADMIN", async () => {
    await expect(
      mocks.service.create({
        mobile: "9876543210",
        name: "Asha",
        role: Role.ADMIN,
        rateCard: 1500,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.create).not.toHaveBeenCalled();
    // Rejected before the mobile is even looked up.
    expect(mocks.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not let a revived editor keep the rate from a previous life", async () => {
    const deleted = makeUser({ id: "old-1", rateCard: 1500, active: false });
    mocks.user.findUnique.mockResolvedValue(deleted);
    mocks.user.update.mockResolvedValue(makeUser({ id: "old-1" }));

    await mocks.service.create({ mobile: "9876543210", name: "Asha" });
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "old-1" },
      data: {
        name: "Asha",
        role: Role.EDITOR,
        rateCard: null,
        active: true,
      },
    });
  });

  it("updates an editor's rate card", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser({ rateCard: 1500 }));
    const updated = makeUser({ rateCard: 1750.5 });
    mocks.user.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("u1", { rateCard: 1750.5 }, admin),
    ).resolves.toBe(updated);
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        mobile: undefined,
        name: undefined,
        role: undefined,
        rateCard: 1750.5,
        active: undefined,
      },
    });
  });

  it("clears the rate card when null is sent, and leaves it alone when omitted", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser({ rateCard: 1500 }));
    mocks.user.update.mockResolvedValue(makeUser());

    await mocks.service.update("u1", { rateCard: null }, admin);
    expect(mocks.user.update.mock.calls[0]?.[0].data.rateCard).toBeNull();

    await mocks.service.update("u1", { name: "Asha R." }, admin);
    expect(mocks.user.update.mock.calls[1]?.[0].data.rateCard).toBeUndefined();
  });

  it("clears the rate card when an editor is promoted to ADMIN", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser({ rateCard: 1500 }));
    mocks.user.update.mockResolvedValue(makeUser({ role: Role.ADMIN }));

    await mocks.service.update("u1", { role: Role.ADMIN }, admin);
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        mobile: undefined,
        name: undefined,
        role: Role.ADMIN,
        rateCard: null,
        active: undefined,
      },
    });
  });

  it("rejects a rate card sent for a user who is already an ADMIN", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser({ id: "u2", role: Role.ADMIN }));

    await expect(
      mocks.service.update("u2", { rateCard: 1500 }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("rejects a rate card sent alongside a promotion to ADMIN", async () => {
    mocks.user.findFirst.mockResolvedValue(makeUser());

    await expect(
      mocks.service.update("u1", { role: Role.ADMIN, rateCard: 1500 }, admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("accepts a rate card alongside a demotion to EDITOR", async () => {
    mocks.user.findFirst.mockResolvedValue(
      makeUser({ id: "u2", role: Role.ADMIN }),
    );
    const updated = makeUser({ id: "u2", rateCard: 1500 });
    mocks.user.update.mockResolvedValue(updated);

    await expect(
      mocks.service.update("u2", { role: Role.EDITOR, rateCard: 1500 }, admin),
    ).resolves.toBe(updated);
    expect(mocks.user.update.mock.calls[0]?.[0].data.rateCard).toBe(1500);
  });
});

describe("UsersService.remove", () => {
  it("soft-deletes instead of deleting, and returns the updated row", async () => {
    const target = makeUser({ id: "u2" });
    mocks.user.findFirst.mockResolvedValue(target);
    const deleted = makeUser({ id: "u2", active: false });
    mocks.user.update.mockResolvedValue(deleted);

    await expect(mocks.service.remove("u2", admin)).resolves.toBe(deleted);
    expect(mocks.user.update).toHaveBeenCalledWith({
      where: { id: "u2" },
      data: { active: false },
    });
  });

  it("refuses to let an admin delete their own account", async () => {
    await expect(mocks.service.remove(admin.id, admin)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.user.update).not.toHaveBeenCalled();
  });

  it("throws NotFound for an already soft-deleted user", async () => {
    mocks.user.findFirst.mockResolvedValue(null);

    await expect(mocks.service.remove("gone", admin)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mocks.user.update).not.toHaveBeenCalled();
  });
});
