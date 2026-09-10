import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { Worksheet } from "exceljs";
import {
  buildVendorTemplate,
  buildVendorTemplateWorkbook,
} from "./vendor-import.template.js";
import { VendorImportParser, readCellText } from "./vendor-import.parser.js";
import {
  IMPORT_SHEET_NAME,
  VENDOR_IMPORT_COLUMNS,
} from "./vendor-import.columns.js";

function textsIn(sheet: Worksheet, rowNumber: number): string[] {
  const values: string[] = [];
  sheet.getRow(rowNumber).eachCell((cell) => values.push(readCellText(cell)));
  return values;
}

function allText(sheet: Worksheet): string {
  const lines: string[] = [];
  sheet.eachRow((_row, rowNumber) => {
    lines.push(textsIn(sheet, rowNumber).join(" "));
  });
  return lines.join("\n");
}

const workbook = buildVendorTemplateWorkbook();
const sheet = workbook.getWorksheet(IMPORT_SHEET_NAME);
const instructions = workbook.getWorksheet("Instructions");

describe("buildVendorTemplateWorkbook", () => {
  it("has a Vendors sheet and an Instructions sheet", () => {
    expect(sheet).toBeDefined();
    expect(instructions).toBeDefined();
  });

  it("writes the canonical headers, in the order the columns declare", () => {
    expect(sheet && textsIn(sheet, 1)).toEqual(
      VENDOR_IMPORT_COLUMNS.map((column) => column.header),
    );
  });

  it("makes the header row bold and freezes it", () => {
    expect(sheet?.getRow(1).font?.bold).toBe(true);

    // views is a union; ySplit only exists on the frozen variant.
    const view = sheet?.views[0];
    expect(view?.state).toBe("frozen");
    if (view?.state === "frozen") {
      expect(view.ySplit).toBe(1);
    }
  });

  it("formats the phone column as Text so Excel keeps + and leading zeros", () => {
    expect(sheet?.getColumn("phoneNumber").numFmt).toBe("@");
  });

  it("notes on each header whether the column is required", () => {
    VENDOR_IMPORT_COLUMNS.forEach((column, index) => {
      const note = sheet?.getCell(1, index + 1).note;
      expect(note).toBe(column.required ? "Required" : "Optional");
    });
  });

  it("ships no example data — only the header row", () => {
    expect(sheet?.rowCount).toBe(1);
  });

  it("derives the instructions from the column definition", () => {
    const text = instructions ? allText(instructions) : "";

    // Required headers are named, so the sheet cannot drift from the parser.
    for (const column of VENDOR_IMPORT_COLUMNS.filter((c) => c.required)) {
      expect(text).toContain(column.header);
    }
    expect(text).toMatch(/row 2/i);
    expect(text).toMatch(/5,000/);
    expect(text).toMatch(/2 MB/);
    expect(text).toMatch(/\.xlsx/);
    expect(text).toContain(IMPORT_SHEET_NAME);
  });
});

describe("buildVendorTemplate", () => {
  it("resolves to a Node Buffer", async () => {
    expect(Buffer.isBuffer(await buildVendorTemplate())).toBe(true);
  });

  it("round-trips through the parser as an empty, valid sheet", async () => {
    // The strongest guarantee this file can make: whatever the template says
    // the columns are, the parser agrees, and an untouched template imports
    // cleanly as zero rows rather than as an error.
    const parser = new VendorImportParser();

    await expect(parser.parse(await buildVendorTemplate())).resolves.toEqual(
      [],
    );
  });
});
