import type { CreateVendorDto } from "../dto/create-vendor.dto.js";

/**
 * Wire types for bulk vendor import. Mirrored verbatim in
 * apps/web/src/lib/types.ts — keep the two in step.
 */

export type VendorImportRowStatus = "created" | "duplicate" | "error";

export interface VendorImportRowResult {
  /**
   * 1-based Excel row number, so it can be read back against the file the
   * admin uploaded: the header is row 1 and the first data row is 2. Blank
   * rows are skipped but still consume their number, so the reported numbers
   * always match what Excel shows in the gutter.
   */
  row: number;
  status: VendorImportRowStatus;
  /** Trimmed raw text, for display — present even when the row failed. */
  name: string | null;
  /** Normalised when parseable, otherwise the raw text. */
  phoneNumber: string | null;
  /** Why the row was skipped. Null for a created row. */
  message: string | null;
}

export interface VendorImportResult {
  fileName: string;
  /**
   * Non-blank data rows. `created + duplicates + errors === totalRows`
   * always holds, including when a concurrent insert steals a phone number
   * mid-import.
   */
  totalRows: number;
  created: number;
  duplicates: number;
  errors: number;
  /** Every non-blank row, in sheet order. */
  rows: VendorImportRowResult[];
}

/**
 * One parsed spreadsheet row, before it has met the database.
 *
 * A valid row carries a fully validated CreateVendorDto, so the importer never
 * re-derives what the DTO already decided; an invalid one carries the raw text
 * for display plus the reason it was rejected.
 */
export type ParsedVendorRow =
  | {
      row: number;
      valid: true;
      data: CreateVendorDto;
      name: string;
      phoneNumber: string;
    }
  | {
      row: number;
      valid: false;
      name: string | null;
      phoneNumber: string | null;
      message: string;
    };

/**
 * The bit of multer's memory-storage file that we actually use.
 *
 * @types/multer is not installed and tsconfig pins types:["node"], so the
 * Express.Multer.File global does not exist here. This must stay an INTERFACE:
 * a class-typed @UploadedFile() parameter would be run through the global
 * ValidationPipe and rejected by forbidNonWhitelisted.
 */
export interface UploadedSpreadsheet {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}
