import type { CreateVendorDto } from "../dto/create-vendor.dto.js";

/**
 * The single definition of the import spreadsheet's shape.
 *
 * The template writer and the parser both read this array, so a column cannot
 * exist in the generated template without the parser understanding it, and the
 * Instructions sheet cannot describe a rule the code does not enforce.
 */
export interface VendorImportColumn {
  /**
   * Typed as a property of CreateVendorDto: a column pointing at a field the
   * DTO does not have fails to compile, which is what keeps the spreadsheet
   * and the API contract from drifting apart.
   */
  key: keyof CreateVendorDto;
  /** Canonical header written into the template. */
  header: string;
  /**
   * Other headers accepted on upload. Matched after normalisation, so casing,
   * spaces and punctuation do not matter — these only need to cover genuinely
   * different words.
   */
  aliases: string[];
  required: boolean;
  /** Template column width, in Excel's character units. */
  width: number;
  /** Force the column to Text so Excel cannot mangle the value. */
  textFormat?: boolean;
}

export const VENDOR_IMPORT_COLUMNS: readonly VendorImportColumn[] = [
  {
    key: "name",
    header: "Name",
    // "editor" is kept alongside "vendor": most vendors are video editors and
    // existing lists are headed that way.
    aliases: ["full name", "vendor", "editor"],
    required: true,
    width: 28,
  },
  {
    key: "phoneNumber",
    header: "Phone Number",
    aliases: ["phone", "phone_number", "mobile", "contact", "whatsapp"],
    required: true,
    width: 20,
    textFormat: true,
  },
  {
    key: "email",
    header: "Email",
    aliases: ["e-mail", "mail"],
    required: false,
    width: 30,
  },
  {
    key: "instagram",
    header: "Instagram",
    aliases: ["insta", "ig"],
    required: false,
    width: 22,
  },
  {
    key: "twitter",
    header: "Twitter",
    aliases: ["x"],
    required: false,
    width: 22,
  },
  {
    key: "linkedin",
    header: "LinkedIn",
    aliases: ["linked in"],
    required: false,
    width: 26,
  },
];

/**
 * Cap on data rows per upload. Large enough for any realistic contact list,
 * small enough that a runaway file is rejected before it is parsed row by row.
 */
export const MAX_IMPORT_ROWS = 5_000;

/** Upload size cap, enforced by multer before the buffer reaches us. */
export const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Rows per createManyAndReturn call. Postgres caps a statement at 65535 bind
 * parameters; at seven columns a row this leaves an order of magnitude of
 * headroom while still being one round trip for a typical import.
 */
export const IMPORT_INSERT_CHUNK = 1_000;

export const TEMPLATE_FILE_NAME = "vendors-import-template.xlsx";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Sheet the parser prefers; it falls back to the first sheet in the book. */
export const IMPORT_SHEET_NAME = "Vendors";

/**
 * Reduces a header to its comparable core, so "Phone Number", "PHONE_NUMBER"
 * and "phone number " all collapse to the same key.
 */
export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Normalised header -> DTO key. The canonical header is always registered as
 * its own alias, so the generated template round-trips through the parser.
 */
export function buildHeaderLookup(): Map<string, keyof CreateVendorDto> {
  const lookup = new Map<string, keyof CreateVendorDto>();
  for (const column of VENDOR_IMPORT_COLUMNS) {
    for (const alias of [column.header, ...column.aliases]) {
      lookup.set(normalizeHeader(alias), column.key);
    }
  }
  return lookup;
}
