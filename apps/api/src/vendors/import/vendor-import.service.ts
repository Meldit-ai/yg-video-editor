import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service.js";
import { IMPORT_INSERT_CHUNK } from "./vendor-import.columns.js";
import { VendorImportParser } from "./vendor-import.parser.js";
import { buildVendorTemplate } from "./vendor-import.template.js";
import type {
  ParsedVendorRow,
  UploadedSpreadsheet,
  VendorImportResult,
  VendorImportRowResult,
  VendorImportRowStatus,
} from "./vendor-import.types.js";

type ValidRow = Extract<ParsedVendorRow, { valid: true }>;

interface RowOutcome {
  status: VendorImportRowStatus;
  message: string | null;
}

/**
 * Bulk vendor import.
 *
 * Deliberately not transactional: a spreadsheet of a hundred contacts with two
 * bad rows should import ninety-eight vendors, not none. What the admin gets
 * back instead of all-or-nothing is a verdict for every row, and the counts
 * always reconcile — `created + duplicates + errors === totalRows` — even when
 * another request inserts one of the same numbers while this one is running.
 */
@Injectable()
export class VendorImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parser: VendorImportParser,
  ) {}

  /** The blank import template, as an .xlsx buffer. */
  buildTemplate(): Promise<Buffer> {
    return buildVendorTemplate();
  }

  async importFile(
    file: UploadedSpreadsheet | undefined,
  ): Promise<VendorImportResult> {
    if (!file) {
      throw new BadRequestException(
        'Upload an .xlsx file in the multipart field "file".',
      );
    }
    // Checked before parsing so a .csv gets a message about its format rather
    // than about being an unreadable workbook.
    if (!/\.xlsx$/i.test(file.originalname)) {
      throw new BadRequestException(
        `"${file.originalname}" is not an .xlsx file. Save the sheet as ` +
          `.xlsx and upload it again.`,
      );
    }

    const parsed = await this.parser.parse(file.buffer);
    const outcomes = new Map<number, RowOutcome>();

    // Pass 1 — rows the file itself rules out: invalid, or a number that an
    // earlier row in the same file already claimed.
    const seen = new Map<string, number>();
    const candidates: ValidRow[] = [];
    for (const row of parsed) {
      if (!row.valid) {
        outcomes.set(row.row, { status: "error", message: row.message });
        continue;
      }
      const firstRow = seen.get(row.phoneNumber);
      if (firstRow !== undefined) {
        outcomes.set(row.row, {
          status: "duplicate",
          message: `Duplicate of row ${firstRow} in this file`,
        });
        continue;
      }
      seen.set(row.phoneNumber, row.row);
      candidates.push(row);
    }

    // Pass 2 — numbers the directory already holds. One query for the whole
    // file, and none at all when nothing survived pass 1.
    let insertable = candidates;
    if (candidates.length > 0) {
      const existing = await this.prisma.client.vendor.findMany({
        where: {
          phoneNumber: { in: candidates.map((row) => row.phoneNumber) },
        },
        select: { phoneNumber: true, active: true, name: true },
      });
      const byPhoneNumber = new Map(
        existing.map((vendor) => [vendor.phoneNumber, vendor]),
      );
      insertable = candidates.filter((candidate) => {
        const match = byPhoneNumber.get(candidate.phoneNumber);
        if (!match) return true;
        outcomes.set(candidate.row, {
          status: "duplicate",
          message:
            `Already exists (${match.active ? "active" : "inactive"}) — ` +
            `${match.name}`,
        });
        return false;
      });
    }

    // Pass 3 — insert what is left. ON CONFLICT DO NOTHING RETURNING, so a
    // number inserted between pass 2 and here simply does not come back, and
    // is reported as a duplicate rather than failing the request.
    for (
      let offset = 0;
      offset < insertable.length;
      offset += IMPORT_INSERT_CHUNK
    ) {
      const chunk = insertable.slice(offset, offset + IMPORT_INSERT_CHUNK);
      const created = await this.prisma.client.vendor.createManyAndReturn({
        data: chunk.map(({ data }) => ({
          name: data.name,
          phoneNumber: data.phoneNumber,
          email: data.email ?? null,
          instagram: data.instagram ?? null,
          twitter: data.twitter ?? null,
          linkedin: data.linkedin ?? null,
        })),
        skipDuplicates: true,
        select: { phoneNumber: true },
      });

      const inserted = new Set(created.map((row) => row.phoneNumber));
      for (const candidate of chunk) {
        outcomes.set(
          candidate.row,
          inserted.has(candidate.phoneNumber)
            ? { status: "created", message: null }
            : {
                status: "duplicate",
                message: "Already exists (added concurrently)",
              },
        );
      }
    }

    const rows: VendorImportRowResult[] = parsed.map((row) => {
      const outcome = outcomes.get(row.row) ?? {
        status: "error" as const,
        message: "This row could not be processed.",
      };
      return {
        row: row.row,
        status: outcome.status,
        name: row.name,
        phoneNumber: row.phoneNumber,
        message: outcome.message,
      };
    });

    return {
      fileName: file.originalname,
      totalRows: rows.length,
      created: rows.filter((row) => row.status === "created").length,
      duplicates: rows.filter((row) => row.status === "duplicate").length,
      errors: rows.filter((row) => row.status === "error").length,
      rows,
    };
  }
}
