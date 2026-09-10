import { BadRequestException, Injectable } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
// exceljs is CJS with `module.exports = <identifier>`, which Node's CJS lexer
// cannot see: a named import type-checks and then throws at boot. Default
// import for values, `import type` for types.
import ExcelJS from "exceljs";
import type { Cell, Row } from "exceljs";
import { CreateVendorDto } from "../dto/create-vendor.dto.js";
import {
  IMPORT_SHEET_NAME,
  MAX_IMPORT_ROWS,
  VENDOR_IMPORT_COLUMNS,
  buildHeaderLookup,
  normalizeHeader,
} from "./vendor-import.columns.js";
import type { ParsedVendorRow } from "./vendor-import.types.js";

/** Renders a list of headers the way the error messages quote them. */
function quoteAll(values: string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

/**
 * Best-effort text of a cell value that `cell.text` could not give us.
 * Kept separate from readCellText so the recursion reads plainly.
 */
function cellValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.richText)) {
    return (record.richText as { text?: unknown }[])
      .map((run) => (typeof run.text === "string" ? run.text : ""))
      .join("");
  }
  // A hyperlink carries its display text, which may itself be rich text.
  if ("hyperlink" in record) return cellValueToText(record.text);
  if ("formula" in record || "sharedFormula" in record) {
    return cellValueToText(record.result);
  }
  if ("error" in record) return cellValueToText(record.error);
  return "";
}

/**
 * The text a human sees in a cell.
 *
 * `cell.text` is typed `string`, but exceljs returns the raw model text for a
 * hyperlink — and that is an object when the display text is rich text, which
 * is exactly what Excel produces after it auto-links a typed email address.
 * So the type is checked rather than trusted, and `cell.value` is unpicked by
 * hand when it turns out to be a lie.
 *
 * Numbers arrive via toString(), so a 10-digit phone typed as a number comes
 * back as "9876543210" rather than in scientific notation.
 */
export function readCellText(cell: Cell): string {
  const text: unknown = cell.text;
  if (typeof text === "string") return text;
  return cellValueToText(cell.value);
}

/**
 * Column number -> DTO key, derived from the header row.
 *
 * Unknown headers are ignored rather than rejected: bookkeeping columns like
 * "Rate per video" are normal in a real contact list, and ignoring them is
 * also what keeps them away from the DTO, whose validation runs with
 * forbidNonWhitelisted and would otherwise fail the whole file.
 *
 * @throws BadRequestException when a required column is absent, or when two
 * columns claim the same field and there is no way to know which one wins.
 */
export function resolveColumnMap(
  headerRow: Row,
): Map<number, keyof CreateVendorDto> {
  const lookup = buildHeaderLookup();
  const columns = new Map<number, keyof CreateVendorDto>();
  const claimedBy = new Map<keyof CreateVendorDto, string>();
  const found: string[] = [];

  headerRow.eachCell((cell, columnNumber) => {
    const header = readCellText(cell).trim();
    if (header.length === 0) return;
    found.push(header);

    const key = lookup.get(normalizeHeader(header));
    if (key === undefined) return;

    const claimed = claimedBy.get(key);
    if (claimed !== undefined) {
      throw new BadRequestException(
        `The columns ${quoteAll([claimed, header])} both mean the same field. ` +
          `Remove one of them and upload again.`,
      );
    }
    claimedBy.set(key, header);
    columns.set(columnNumber, key);
  });

  const missing = VENDOR_IMPORT_COLUMNS.filter(
    (column) => column.required && !claimedBy.has(column.key),
  );
  if (missing.length > 0) {
    throw new BadRequestException(
      `The sheet is missing the ${quoteAll(missing.map((column) => column.header))} ` +
        `column. Row 1 must hold the headers; found ` +
        `${found.length > 0 ? quoteAll(found) : "no headers"}. Download the ` +
        `template if you are not sure of the format.`,
    );
  }

  return columns;
}

export type VendorRowValidation =
  | { valid: true; data: CreateVendorDto }
  | { valid: false; message: string };

/**
 * Runs one spreadsheet row through CreateVendorDto with the same options
 * main.ts installs globally, so an imported row and a POSTed body are accepted
 * or rejected for identical reasons, with identical wording.
 */
export function validateVendorRow(
  plain: Record<string, unknown>,
): VendorRowValidation {
  const dto = plainToInstance(CreateVendorDto, plain);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length === 0) {
    return { valid: true, data: dto };
  }

  const message = errors
    .flatMap((error) => Object.values(error.constraints ?? {}))
    .join("; ");
  return {
    valid: false,
    message: message.length > 0 ? message : "This row is not valid.",
  };
}

/**
 * Turns an uploaded .xlsx buffer into one ParsedVendorRow per non-blank data
 * row. Knows nothing about the database: whole-file problems are thrown as
 * BadRequestException, per-row problems are returned as data.
 */
@Injectable()
export class VendorImportParser {
  async parse(buffer: Buffer): Promise<ParsedVendorRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new BadRequestException(
        "That file could not be read as an .xlsx workbook. Re-save it from " +
          "Excel and upload it again.",
      );
    }

    const sheet =
      workbook.getWorksheet(IMPORT_SHEET_NAME) ?? workbook.worksheets[0];
    if (!sheet) {
      throw new BadRequestException("That workbook has no sheets.");
    }

    const columns = resolveColumnMap(sheet.getRow(1));
    const rows: ParsedVendorRow[] = [];

    // eachRow skips rows that do not physically exist, so gaps cost nothing
    // and the row numbers stay the ones Excel shows in the gutter. Never loop
    // over getRow(i) instead — that creates the rows it reads.
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;

      const cells = new Map<keyof CreateVendorDto, string>();
      let hasValue = false;
      for (const [columnNumber, key] of columns) {
        const text = readCellText(row.getCell(columnNumber)).trim();
        if (text.length > 0) hasValue = true;
        cells.set(key, text);
      }
      // A row with nothing in any mapped column is spacing, not data.
      if (!hasValue) return;

      if (rows.length >= MAX_IMPORT_ROWS) {
        throw new BadRequestException(
          `A single import can hold at most ` +
            `${MAX_IMPORT_ROWS.toLocaleString("en-US")} vendors. Split the ` +
            `list and upload it in batches.`,
        );
      }

      // Required fields are handed over even when blank, so the DTO answers
      // with "name must not be empty" rather than the unhelpful "must be a
      // string"; blank optional fields are omitted so they stay undefined.
      const plain: Record<string, string> = {};
      for (const column of VENDOR_IMPORT_COLUMNS) {
        const text = cells.get(column.key) ?? "";
        if (column.required || text.length > 0) {
          plain[column.key] = text;
        }
      }

      const rawName = cells.get("name") ?? "";
      const rawPhone = cells.get("phoneNumber") ?? "";
      const validation = validateVendorRow(plain);

      if (validation.valid) {
        rows.push({
          row: rowNumber,
          valid: true,
          data: validation.data,
          name: validation.data.name,
          phoneNumber: validation.data.phoneNumber,
        });
      } else {
        rows.push({
          row: rowNumber,
          valid: false,
          name: rawName.length > 0 ? rawName : null,
          phoneNumber: rawPhone.length > 0 ? rawPhone : null,
          message: validation.message,
        });
      }
    });

    return rows;
  }
}
