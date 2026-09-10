import { describe, it, expect, vi, beforeEach } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service.js";
import type { CreateVendorDto } from "../dto/create-vendor.dto.js";
import { VendorImportService } from "./vendor-import.service.js";
import type { VendorImportParser } from "./vendor-import.parser.js";
import { IMPORT_INSERT_CHUNK, XLSX_MIME } from "./vendor-import.columns.js";
import type {
  ParsedVendorRow,
  UploadedSpreadsheet,
} from "./vendor-import.types.js";

/**
 * The parser is stubbed out entirely: what this suite is about is how parsed
 * rows are classified against the database, not how a workbook is read.
 */
function createMocks() {
  const vendor = {
    findMany: vi.fn(),
    createManyAndReturn: vi.fn(),
  };
  const parser = { parse: vi.fn() };
  const service = new VendorImportService(
    { client: { vendor } } as unknown as PrismaService,
    parser as unknown as VendorImportParser,
  );
  return { service, vendor, parser };
}

function upload(originalname = "vendors.xlsx"): UploadedSpreadsheet {
  return {
    buffer: Buffer.from("pretend this is a workbook"),
    originalname,
    mimetype: XLSX_MIME,
    size: 26,
  };
}

function validRow(
  row: number,
  name: string,
  phoneNumber: string,
  extra: Partial<CreateVendorDto> = {},
): ParsedVendorRow {
  return {
    row,
    valid: true,
    data: { name, phoneNumber, ...extra } as CreateVendorDto,
    name,
    phoneNumber,
  };
}

function invalidRow(
  row: number,
  message: string,
  name: string | null = null,
  phoneNumber: string | null = null,
): ParsedVendorRow {
  return { row, valid: false, name, phoneNumber, message };
}

/** The full column set the service must write, with explicit nulls. */
function insertData(name: string, phoneNumber: string) {
  return {
    name,
    phoneNumber,
    email: null,
    instagram: null,
    twitter: null,
    linkedin: null,
  };
}

let mocks: ReturnType<typeof createMocks>;

beforeEach(() => {
  mocks = createMocks();
});

describe("VendorImportService.importFile", () => {
  it("rejects a missing file before touching the parser", async () => {
    await expect(mocks.service.importFile(undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.parser.parse).not.toHaveBeenCalled();
  });

  it("rejects a file that is not .xlsx before parsing it", async () => {
    await expect(
      mocks.service.importFile(upload("contacts.csv")),
    ).rejects.toThrow(/\.xlsx/);
    expect(mocks.parser.parse).not.toHaveBeenCalled();
    expect(mocks.vendor.findMany).not.toHaveBeenCalled();
    expect(mocks.vendor.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("creates every new row and reports them in sheet order", async () => {
    mocks.parser.parse.mockResolvedValue([
      validRow(2, "Asha Rao", "9876543210"),
      validRow(3, "Bo Yang", "9000000001"),
    ]);
    mocks.vendor.findMany.mockResolvedValue([]);
    mocks.vendor.createManyAndReturn.mockResolvedValue([
      { phoneNumber: "9876543210" },
      { phoneNumber: "9000000001" },
    ]);

    const result = await mocks.service.importFile(upload("my vendors.xlsx"));

    expect(mocks.vendor.findMany).toHaveBeenCalledWith({
      where: { phoneNumber: { in: ["9876543210", "9000000001"] } },
      select: { phoneNumber: true, active: true, name: true },
    });
    expect(mocks.vendor.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        insertData("Asha Rao", "9876543210"),
        insertData("Bo Yang", "9000000001"),
      ],
      skipDuplicates: true,
      select: { phoneNumber: true },
    });
    expect(result).toEqual({
      fileName: "my vendors.xlsx",
      totalRows: 2,
      created: 2,
      duplicates: 0,
      errors: 0,
      rows: [
        {
          row: 2,
          status: "created",
          name: "Asha Rao",
          phoneNumber: "9876543210",
          message: null,
        },
        {
          row: 3,
          status: "created",
          name: "Bo Yang",
          phoneNumber: "9000000001",
          message: null,
        },
      ],
    });
  });

  it("keeps invalid rows out of the lookup and the insert", async () => {
    mocks.parser.parse.mockResolvedValue([
      invalidRow(2, "name must not be empty", null, "9876543210"),
      validRow(3, "Bo Yang", "9000000001"),
    ]);
    mocks.vendor.findMany.mockResolvedValue([]);
    mocks.vendor.createManyAndReturn.mockResolvedValue([
      { phoneNumber: "9000000001" },
    ]);

    const result = await mocks.service.importFile(upload());

    expect(mocks.vendor.findMany).toHaveBeenCalledWith({
      where: { phoneNumber: { in: ["9000000001"] } },
      select: { phoneNumber: true, active: true, name: true },
    });
    expect(mocks.vendor.createManyAndReturn).toHaveBeenCalledWith({
      data: [insertData("Bo Yang", "9000000001")],
      skipDuplicates: true,
      select: { phoneNumber: true },
    });
    expect(result.created).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.rows[0]).toEqual({
      row: 2,
      status: "error",
      name: null,
      phoneNumber: "9876543210",
      message: "name must not be empty",
    });
  });

  it("keeps the first of two rows with the same number and reports the second", async () => {
    mocks.parser.parse.mockResolvedValue([
      validRow(2, "Asha Rao", "9876543210"),
      validRow(3, "Asha R.", "9876543210"),
    ]);
    mocks.vendor.findMany.mockResolvedValue([]);
    mocks.vendor.createManyAndReturn.mockResolvedValue([
      { phoneNumber: "9876543210" },
    ]);

    const result = await mocks.service.importFile(upload());

    expect(mocks.vendor.createManyAndReturn).toHaveBeenCalledWith({
      data: [insertData("Asha Rao", "9876543210")],
      skipDuplicates: true,
      select: { phoneNumber: true },
    });
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.rows[1]?.message).toBe("Duplicate of row 2 in this file");
  });

  it("reports rows already in the directory, active or not", async () => {
    mocks.parser.parse.mockResolvedValue([
      validRow(2, "Asha Rao", "9876543210"),
      validRow(3, "Bo Yang", "9000000001"),
      validRow(4, "Cy Silva", "9000000002"),
    ]);
    mocks.vendor.findMany.mockResolvedValue([
      { phoneNumber: "9876543210", active: true, name: "Asha" },
      { phoneNumber: "9000000001", active: false, name: "Bo" },
    ]);
    mocks.vendor.createManyAndReturn.mockResolvedValue([
      { phoneNumber: "9000000002" },
    ]);

    const result = await mocks.service.importFile(upload());

    // Only the row that is genuinely new is offered to the insert.
    expect(mocks.vendor.createManyAndReturn).toHaveBeenCalledWith({
      data: [insertData("Cy Silva", "9000000002")],
      skipDuplicates: true,
      select: { phoneNumber: true },
    });
    expect(result.rows[0]?.status).toBe("duplicate");
    expect(result.rows[0]?.message).toMatch(/Already exists \(active\)/);
    expect(result.rows[1]?.message).toMatch(/Already exists \(inactive\)/);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(2);
  });

  it("reconciles a row another request inserted mid-import", async () => {
    mocks.parser.parse.mockResolvedValue([
      validRow(2, "Asha Rao", "9876543210"),
      validRow(3, "Bo Yang", "9000000001"),
    ]);
    mocks.vendor.findMany.mockResolvedValue([]);
    // skipDuplicates swallowed one row: it is not in the returned set.
    mocks.vendor.createManyAndReturn.mockResolvedValue([
      { phoneNumber: "9876543210" },
    ]);

    const result = await mocks.service.importFile(upload());

    expect(result.rows[1]?.status).toBe("duplicate");
    expect(result.rows[1]?.message).toBe("Already exists (added concurrently)");
    expect(result.created + result.duplicates + result.errors).toBe(
      result.totalRows,
    );
  });

  it("touches the database at all only when a row could be inserted", async () => {
    mocks.parser.parse.mockResolvedValue([
      invalidRow(2, "name must not be empty"),
      invalidRow(3, "phoneNumber must be 10-15 digits"),
    ]);

    const result = await mocks.service.importFile(upload());

    expect(mocks.vendor.findMany).not.toHaveBeenCalled();
    expect(mocks.vendor.createManyAndReturn).not.toHaveBeenCalled();
    expect(result.errors).toBe(2);
    expect(result.totalRows).toBe(2);
  });

  it("inserts in chunks so a big file stays under the bind-parameter limit", async () => {
    const rows: ParsedVendorRow[] = [];
    for (let index = 0; index <= IMPORT_INSERT_CHUNK; index += 1) {
      rows.push(
        validRow(
          index + 2,
          `Vendor ${index}`,
          `90000${String(index).padStart(5, "0")}`,
        ),
      );
    }
    mocks.parser.parse.mockResolvedValue(rows);
    mocks.vendor.findMany.mockResolvedValue([]);
    mocks.vendor.createManyAndReturn.mockImplementation(
      ({ data }: { data: { phoneNumber: string }[] }) =>
        Promise.resolve(data.map(({ phoneNumber }) => ({ phoneNumber }))),
    );

    const result = await mocks.service.importFile(upload());

    expect(mocks.vendor.createManyAndReturn).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(IMPORT_INSERT_CHUNK + 1);
  });

  it("echoes the uploaded file name back", async () => {
    mocks.parser.parse.mockResolvedValue([]);

    const result = await mocks.service.importFile(upload("Q3 vendors.xlsx"));

    expect(result).toEqual({
      fileName: "Q3 vendors.xlsx",
      totalRows: 0,
      created: 0,
      duplicates: 0,
      errors: 0,
      rows: [],
    });
  });
});

describe("VendorImportService.buildTemplate", () => {
  it("resolves to a Node Buffer", async () => {
    expect(Buffer.isBuffer(await mocks.service.buildTemplate())).toBe(true);
  });
});
