/**
 * Seeds the first ADMIN user.
 *
 * The app is a closed system: login rejects unknown mobile numbers and only an
 * ADMIN can create users, so a fresh database needs exactly one bootstrap
 * account or nobody can ever get in.
 *
 * Run with `pnpm db:seed`. Safe to re-run: it upserts on mobile.
 */
import "dotenv/config";
import { createPrismaClient } from "../src/client.js";

const mobile = process.env.ADMIN_MOBILE ?? "9999999999";
const name = process.env.ADMIN_NAME ?? "Admin";

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  try {
    const admin = await prisma.user.upsert({
      where: { mobile },
      // Re-seeding must not silently undo a deliberate rename, but it should
      // restore access if the bootstrap admin was soft-deleted.
      update: { role: "ADMIN", active: true },
      create: { mobile, name, role: "ADMIN" },
    });
    console.log(`Seeded ADMIN ${admin.name} (${admin.mobile}) — log in with OTP 1234`);
  } finally {
    await prisma.$disconnect();
  }
}

// Not top-level await: this package is CommonJS, where an async module
// entry point fails with ERR_REQUIRE_ASYNC_MODULE under tsx.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
