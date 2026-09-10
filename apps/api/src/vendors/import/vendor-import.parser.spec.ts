import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import ExcelJS from "exceljs";
import type { Cell, CellValue, Row, Workbook, Worksheet } from "exceljs";
import {
  VendorImportParser,
  readCellText,
  resolveColumnMap,
  validateVendorRow,
} from "./vendor-import.parser.js";
import { MAX_IMPORT_ROWS } from "./vendor-import.columns.js";

/**
 * Every workbook here is built in memory and handed to the parser as a buffer,
 * so the suite exercises the real exceljs read path without any fixture files
 * to keep in sync.
 */

const parser = new VendorImportParser();

const HEADERS = [
  "Name",
  "Phone Number",
  "Email",
  "Instagram",
  "Twitter",
  "LinkedIn",
];

async function toBuffer(workbook: Workbook): Promise<Buffer> {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A one-sheet workbook built by hand, for gaps and exotic cell values. */
async function bufferFrom(
  build: (sheet: Worksheet) => void,
  sheetName = "Vendors",
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook.addWorksheet(sheetName));
  return toBuffer(workbook);
}

/** A one-sheet workbook whose rows are written from row 1 downwards. */
async function bufferOf(
  rows: unknown[][],
  sheetName = "Vendors",
): Promise<Buffer> {
  return bufferFrom((sheet) => {
    rows.forEach((values, index) => {
      sheet.getRow(index + 1).values = values as CellValue[];
    });
  }, sheetName);
}

function cellWith(value: unknown): Cell {
  const sheet = new ExcelJS.Workbook().addWorksheet("scratch");
  const cell = sheet.getCell("A1");
  cell.value = value as CellValue;
  return cell;
}

function headerRow(values: unknown[]): Row {
  const sheet = new ExcelJS.Workbook().addWorksheet("scratch");
  const row = sheet.getRow(1);
  row.values = values as CellValue[];
  return row;
}

describe("VendorImportParser.parse", () => {
  it("parses canonical headers into validated rows numbered from 2", async () => {
    const buffer = await bufferOf([
      HEADERS,
      [
        "Asha Rao",
        "9876543210",
        "asha@example.com",
        "@asha",
        "asha_x",
        "linkedin.com/in/asha",
      ],
      ["Bo Yang", "9000000001"],
    ]);

    const rows = await parser.parse(buffer);

    expect(rows.map((row) => row.row)).toEqual([2, 3]);
    const first = rows[0];
    expect(first?.valid).toBe(true);
    if (first?.valid) {
      expect(first.data).toEqual({
        name: "Asha Rao",
        phoneNumber: "9876543210",
        email: "asha@example.com",
        instagram: "@asha",
        twitter: "asha_x",
        linkedin: "linkedin.com/in/asha",
      });
      expect(first.name).toBe("Asha Rao");
      expect(first.phoneNumber).toBe("9876543210");
    }
  });

  it("accepts aliased and loosely formatted headers", async () => {
    const buffer = await bufferOf([
      ["Full Name*", "PHONE_NUMBER", "E-mail", "Insta", "X", "linked in"],
      [
        "Priya",
        "+91 98765-43210",
        "priya@example.com",
        "priya",
        "priya_x",
        "priya",
      ],
    ]);

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      expect(row.data).toEqual({
        name: "Priya",
        // Separators are stripped by the same transform the endpoint uses.
        phoneNumber: "+919876543210",
        email: "priya@example.com",
        instagram: "priya",
        twitter: "priya_x",
        linkedin: "priya",
      });
    }
  });

  it("rejects a sheet with no phone column, naming the headers it found", async () => {
    const buffer = await bufferOf([
      ["Name", "Email"],
      ["Asha", "asha@example.com"],
    ]);

    await expect(parser.parse(buffer)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(parser.parse(buffer)).rejects.toThrow(/Phone Number/);
    await expect(parser.parse(buffer)).rejects.toThrow(/"Name", "Email"/);
  });

  it("rejects two columns that mean the same field", async () => {
    const buffer = await bufferOf([
      ["Name", "Phone Number", "Mobile"],
      ["Asha", "9876543210", "9000000001"],
    ]);

    await expect(parser.parse(buffer)).rejects.toThrow(/same field/i);
  });

  it("ignores columns it does not recognise", async () => {
    const buffer = await bufferOf([
      ["Name", "Rate per video", "Phone Number"],
      ["Asha", "5000", "9876543210"],
    ]);

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      // The unknown column must never reach the DTO: the global pipe runs with
      // forbidNonWhitelisted and would turn it into a whole-file failure.
      expect(row.data).toEqual({ name: "Asha", phoneNumber: "9876543210" });
    }
  });

  it("skips blank and whitespace-only rows while keeping real row numbers", async () => {
    const buffer = await bufferFrom((sheet) => {
      sheet.getRow(1).values = ["Name", "Phone Number"];
      sheet.getRow(2).values = ["Asha", "9876543210"];
      sheet.getRow(3).values = ["   ", "  "];
      sheet.getRow(4).values = ["Bo", "9000000001"];
    });

    const rows = await parser.parse(buffer);

    expect(rows.map((row) => row.row)).toEqual([2, 4]);
  });

  it("keeps row numbers across a physically absent row", async () => {
    const buffer = await bufferFrom((sheet) => {
      sheet.getRow(1).values = ["Name", "Phone Number"];
      sheet.getRow(2).values = ["Asha", "9876543210"];
      sheet.getRow(6).values = ["Bo", "9000000001"];
    });

    const rows = await parser.parse(buffer);

    expect(rows.map((row) => row.row)).toEqual([2, 6]);
  });

  it("reads a phone number stored as a number", async () => {
    const buffer = await bufferOf([
      ["Name", "Phone Number"],
      ["Asha", 9876543210],
    ]);

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      expect(row.data.phoneNumber).toBe("9876543210");
    }
  });

  it("reads an email Excel turned into a mailto hyperlink", async () => {
    const buffer = await bufferFrom((sheet) => {
      sheet.getRow(1).values = ["Name", "Phone Number", "Email"];
      sheet.getRow(2).values = ["Asha", "9876543210"];
      sheet.getCell("C2").value = {
        text: "asha@example.com",
        hyperlink: "mailto:asha@example.com",
      };
    });

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      expect(row.data.email).toBe("asha@example.com");
    }
  });

  it("reads a rich-text name cell", async () => {
    const buffer = await bufferFrom((sheet) => {
      sheet.getRow(1).values = ["Name", "Phone Number"];
      sheet.getRow(2).values = [undefined, "9876543210"];
      sheet.getCell("A2").value = {
        richText: [{ text: "Pri" }, { text: "ya" }],
      };
    });

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      expect(row.data.name).toBe("Priya");
    }
  });

  it("reports a readable message for each kind of bad row", async () => {
    const buffer = await bufferOf([
      ["Name", "Phone Number", "Email"],
      ["", "9876543210", ""],
      ["Asha", "", ""],
      ["", "", "who@example.com"],
      ["Cy", "9000000002", "not-an-email"],
    ]);

    const rows = await parser.parse(buffer);

    expect(rows.map((row) => row.row)).toEqual([2, 3, 4, 5]);
    expect(rows.every((row) => !row.valid)).toBe(true);

    const [blankName, blankPhone, bothBlank, badEmail] = rows;

    if (blankName && !blankName.valid) {
      expect(blankName.message).toMatch(/name must not be empty/);
      expect(blankName.name).toBeNull();
      // The raw text is still echoed back so the row is recognisable.
      expect(blankName.phoneNumber).toBe("9876543210");
    }

    if (blankPhone && !blankPhone.valid) {
      expect(blankPhone.message).toMatch(/phoneNumber must be 10-15 digits/);
      expect(blankPhone.name).toBe("Asha");
      expect(blankPhone.phoneNumber).toBeNull();
    }

    if (bothBlank && !bothBlank.valid) {
      expect(bothBlank.message).toMatch(/name must not be empty/);
      expect(bothBlank.message).toMatch(/phoneNumber must be 10-15 digits/);
      expect(bothBlank.message).toContain("; ");
    }

    if (badEmail && !badEmail.valid) {
      expect(badEmail.message).toMatch(/email must be a valid email address/);
    }
  });

  it("leaves blank optional cells undefined rather than empty strings", async () => {
    const buffer = await bufferOf([HEADERS, ["Asha", "9876543210", "", "  "]]);

    const rows = await parser.parse(buffer);

    const row = rows[0];
    expect(row?.valid).toBe(true);
    if (row?.valid) {
      expect(row.data.email).toBeUndefined();
      expect(row.data.instagram).toBeUndefined();
      expect(row.data.twitter).toBeUndefined();
      expect(row.data.linkedin).toBeUndefined();
    }
  });

  it("rejects a file with more data rows than the cap", async () => {
    const rows: unknown[][] = [["Name", "Phone Number"]];
    for (let index = 0; index <= MAX_IMPORT_ROWS; index += 1) {
      rows.push([`Vendor ${index}`, `90000${String(index).padStart(5, "0")}`]);
    }

    await expect(parser.parse(await bufferOf(rows))).rejects.toThrow(
      /at most 5,000/,
    );
  });

  it("rejects a buffer that is not a workbook", async () => {
    await expect(
      parser.parse(Buffer.from("this is definitely not a spreadsheet")),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("prefers the sheet named Vendors over the first sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    const notes = workbook.addWorksheet("Notes");
    notes.getRow(1).values = ["Something", "Else"];
    const sheet = workbook.addWorksheet("Vendors");
    sheet.getRow(1).values = ["Name", "Phone Number"];
    sheet.getRow(2).values = ["Asha", "9876543210"];

    const rows = await parser.parse(await toBuffer(workbook));

    expect(rows).toHaveLength(1);
  });

  it("falls back to the first sheet when none is named Vendors", async () => {
    const buffer = await bufferOf(
      [
        ["Name", "Phone Number"],
        ["Asha", "9876543210"],
      ],
      "Sheet1",
    );

    await expect(parser.parse(buffer)).resolves.toHaveLength(1);
  });

  it("returns no rows for a header-only sheet", async () => {
    await expect(parser.parse(await bufferOf([HEADERS]))).resolves.toEqual([]);
  });
});

describe("resolveColumnMap", () => {
  it("maps column numbers to DTO keys and drops unknown headers", () => {
    const map = resolveColumnMap(headerRow(["Name", "Notes", "Phone Number"]));

    expect([...map]).toEqual([
      [1, "name"],
      [3, "phoneNumber"],
    ]);
  });
});

describe("validateVendorRow", () => {
  it("normalises and accepts a good row", () => {
    const result = validateVendorRow({
      name: "  Asha  ",
      phoneNumber: "+91 98765-43210",
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.name).toBe("Asha");
      expect(result.data.phoneNumber).toBe("+919876543210");
    }
  });

  it("joins every constraint message for a bad row", () => {
    const result = validateVendorRow({ name: "", phoneNumber: "" });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toMatch(/name must not be empty/);
      expect(result.message).toMatch(/phoneNumber must be 10-15 digits/);
      expect(result.message).toContain("; ");
    }
  });
});

describe("readCellText", () => {
  it("returns an empty string for an empty cell", () => {
    expect(readCellText(cellWith(null))).toBe("");
  });

  it("stringifies a long number without scientific notation", () => {
    expect(readCellText(cellWith(9876543210))).toBe("9876543210");
  });

  it("stringifies a boolean", () => {
    expect(readCellText(cellWith(true))).toBe("true");
  });

  it("reads a date cell as text", () => {
    expect(
      readCellText(cellWith(new Date("2026-01-01T00:00:00.000Z"))),
    ).toContain("2026");
  });

  it("reads a formula's cached result", () => {
    expect(
      readCellText(
        cellWith({ formula: 'CONCATENATE("Pri","ya")', result: "Priya" }),
      ),
    ).toBe("Priya");
  });

  it("reads an error cell as its error code", () => {
    expect(readCellText(cellWith({ error: "#N/A" }))).toBe("#N/A");
  });

  it("joins rich-text runs", () => {
    expect(
      readCellText(cellWith({ richText: [{ text: "Pri" }, { text: "ya" }] })),
    ).toBe("Priya");
  });

  it("reads a plain hyperlink's display text", () => {
    expect(
      readCellText(
        cellWith({
          text: "asha@example.com",
          hyperlink: "mailto:asha@example.com",
        }),
      ),
    ).toBe("asha@example.com");
  });

  it("reads a hyperlink whose display text is rich text", () => {
    // cell.text is typed string but is the rich-text object here, which is why
    // readCellText cannot simply trust it.
    expect(
      readCellText(
        cellWith({
          text: { richText: [{ text: "asha@" }, { text: "example.com" }] },
          hyperlink: "mailto:asha@example.com",
        }),
      ),
    ).toBe("asha@example.com");
  });
});
