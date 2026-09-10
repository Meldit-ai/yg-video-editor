// Default import only: exceljs is CJS with `module.exports = <identifier>`,
// so a named import type-checks and then throws at boot.
import ExcelJS from "exceljs";
import type { Workbook } from "exceljs";
import {
  IMPORT_SHEET_NAME,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  VENDOR_IMPORT_COLUMNS,
} from "./vendor-import.columns.js";

/** "a, b and c" — for reading rules aloud rather than as a list of cells. */
function listAnd(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1) ?? ""}`;
}

/**
 * The rules shown on the Instructions sheet.
 *
 * Derived from VENDOR_IMPORT_COLUMNS and the import limits rather than typed
 * out, so the sheet cannot end up describing a format the parser does not
 * accept.
 */
function instructionRules(): string[] {
  const required = VENDOR_IMPORT_COLUMNS.filter((column) => column.required);
  const optional = VENDOR_IMPORT_COLUMNS.filter((column) => !column.required);
  const megabytes = MAX_IMPORT_FILE_BYTES / (1024 * 1024);

  return [
    `One vendor per row, starting at row 2. Row 1 is the header row.`,
    `Keep the header names as they are. The order of the columns is up to you.`,
    `${listAnd(required.map((column) => column.header))} are required. ` +
      `${listAnd(optional.map((column) => column.header))} are optional — ` +
      `leave them blank if you do not have them.`,
    `Phone numbers are 10-15 digits with an optional leading +. Spaces, ` +
      `dashes, dots and brackets are removed automatically. Leave the column ` +
      `formatted as Text so Excel keeps the + and any leading zeros.`,
    `Phone numbers must be unique. A number already in the directory — ` +
      `active or inactive — is reported as a duplicate and skipped, and the ` +
      `existing vendor is left untouched.`,
    `A row with an error is skipped and reported back to you; every other ` +
      `row still imports.`,
    `At most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows and ` +
      `${megabytes} MB per file, and the file must be .xlsx.`,
    `The sheet named "${IMPORT_SHEET_NAME}" is the one imported. If the ` +
      `workbook has no such sheet, the first sheet is used.`,
  ];
}

/**
 * The import template, as a workbook — returned unserialised so tests can look
 * inside it rather than diffing bytes.
 */
export function buildVendorTemplateWorkbook(): Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(IMPORT_SHEET_NAME);

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  // Assigning `columns` is what writes row 1 from the headers.
  sheet.columns = VENDOR_IMPORT_COLUMNS.map(({ header, key, width }) => ({
    header,
    key,
    width,
  }));
  sheet.getRow(1).font = { bold: true };

  VENDOR_IMPORT_COLUMNS.forEach((column, index) => {
    sheet.getCell(1, index + 1).note = column.required
      ? "Required"
      : "Optional";
    if (column.textFormat) {
      // Text, so a phone number keeps its + and leading zeros instead of
      // being rendered as 9.88E+09 the moment someone opens the file.
      sheet.getColumn(column.key).numFmt = "@";
    }
  });

  const instructions = workbook.addWorksheet("Instructions");
  instructions.columns = [{ width: 4 }, { width: 110 }];
  instructions.getCell(1, 2).value = "How to fill in this template";
  instructions.getRow(1).font = { bold: true };

  instructionRules().forEach((rule, index) => {
    const rowNumber = index + 2;
    instructions.getCell(rowNumber, 1).value = index + 1;
    const cell = instructions.getCell(rowNumber, 2);
    cell.value = rule;
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  return workbook;
}

/** The import template as an .xlsx buffer, ready to stream to the browser. */
export async function buildVendorTemplate(): Promise<Buffer> {
  const workbook = buildVendorTemplateWorkbook();
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
