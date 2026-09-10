# Vendors directory with Excel bulk import

Date: 2026-09-09
Status: approved, implemented

## Problem

Admins need a directory of the vendors the team works with — mostly video
editors, plus other suppliers — holding a name, phone number, optional email and
social handles. These are **contact records, not login accounts**: the accounts
are `User` rows, and `Role.EDITOR` there is unrelated. Copy on both pages has to
keep the two apart.

Beyond single add/edit and an activate/deactivate toggle, the directory needs a
bulk path: download an Excel template, fill it in, upload it, and get a per-row
account of what happened. Nothing in the repo did multipart upload, spreadsheet
parsing, or binary download before this, so those three pieces are new on both
sides; everything else copies the existing users/campaigns shapes.

## Decisions

| Decision | Choice |
| --- | --- |
| Required fields | `name`, `phoneNumber`. `email`, `instagram`, `twitter`, `linkedin` optional (nullable). |
| Duplicate key | `phoneNumber`, `@unique`, normalised in the DTO (`trim`, strip `[\s\-.()]`, keep a leading `+`) so `POST`, `PATCH` and import agree by construction. |
| Inactive rows | **Visible.** `Vendor.active` is a status toggle, not the hidden soft-delete flag used by `User`/`Campaign`. The list shows every row with an All / Active / Inactive filter. **No DELETE endpoint. No revive-on-create** — 409 instead, whose message says the existing vendor is inactive. |
| Import duplicates | Skipped and reported, both in-file and against the database. The existing row is never touched. |
| Excel library | `exceljs@4.4.0` in `apps/api` only (it both reads and writes; npm's `xlsx` is frozen at 0.18.5 with open advisories). The web bundle gets no spreadsheet code — only the limits. |
| Template | Generated server-side at request time from the same column definition the parser uses. No example data row. |
| Row validation | The parser builds a `CreateVendorDto` per row (`plainToInstance` + `validateSync` with `main.ts`'s options), so import and `POST /vendors` enforce identical rules and produce identical messages. |

## Data model

```prisma
model Vendor {
  id          String  @id @default(cuid())
  name        String
  email       String?
  phoneNumber String  @unique
  instagram   String?
  twitter     String?
  linkedin    String?
  active      Boolean @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([active])
}
```

`active` is the one field that looks like the rest of the schema and means
something different. On `User` and `Campaign` it is the soft-delete flag: false
means deleted, and every read filters it out. On `Vendor` it is a visible
status. Deactivating a vendor is a statement about the working relationship, not
a deletion, so the row stays listed, stays reachable by id, and is re-activated
from the same menu that deactivated it.

## API

All routes are admin-only (`@Roles(Role.ADMIN)` at the class level), return bare
rows or bare arrays, and raise Nest exceptions with sentence messages.

| Route | Body / query | Returns | Errors |
| --- | --- | --- | --- |
| `GET /api/vendors` | `?active=true\|false` (optional) | `Vendor[]`, newest first, **inactive included** | 400 if `active` is not a boolean |
| `GET /api/vendors/import/template` | — | `.xlsx` as a `StreamableFile` attachment | — |
| `POST /api/vendors/import` | multipart field `file`: `.xlsx`, ≤ 2 MB, ≤ 5 000 rows | `VendorImportResult` | 400 no file / not `.xlsx` / unreadable / missing a required header / too many rows; 413 `File too large`; 400 `Unexpected field - …` |
| `GET /api/vendors/:id` | — | `Vendor` (inactive rows are not hidden) | 404 |
| `POST /api/vendors` | `CreateVendorDto` | `Vendor` | 409 on a duplicate number, worded differently for an active vs an inactive match |
| `PATCH /api/vendors/:id` | `UpdateVendorDto` (all optional, incl. `active`) | `Vendor` | 404; 409 if a changed number clashes |

`POST /api/vendors/import` answers **200, not 201**: a run in which every row was
a duplicate created nothing and is still a success, and the body says so. The
static `import/*` routes are declared before `:id`, since Nest matches in
declaration order and would otherwise read `import` as a vendor id.

## Import pipeline

`VendorImportParser` turns a buffer into one `ParsedVendorRow` per non-blank
data row and knows nothing about the database. `VendorImportService` classifies
those rows in three passes:

1. **The file itself** — invalid rows become `error`; a number an earlier row
   already claimed becomes `duplicate` ("Duplicate of row N in this file").
2. **The directory** — one `findMany` for every surviving number; a match
   becomes `duplicate`, naming the existing vendor and whether it is active.
3. **Insert** — the rest in chunks of 1 000 via
   `createManyAndReturn({ skipDuplicates: true })`, i.e. `INSERT … ON CONFLICT DO
   NOTHING RETURNING`. A number inserted by another request between passes 2 and
   3 simply does not come back, and is reported as
   "Already exists (added concurrently)" rather than failing the request.

Because every row ends up in exactly one bucket,
`created + duplicates + errors === totalRows` always holds. There is no
transaction: a hundred-row sheet with two bad rows should import ninety-eight
vendors, not none.

Row numbers are the ones Excel shows in its gutter — the header is row 1, blank
rows are skipped but still consume their number — so a reported problem can be
found in the file the admin uploaded.

## Guardrails

- **The template cannot drift from the parser.** Both read
  `VENDOR_IMPORT_COLUMNS`, whose `key` is typed `keyof CreateVendorDto`, so a
  column naming a field the DTO does not have fails to compile. The Instructions
  sheet is generated from the same array and the same limits. A test round-trips
  a freshly built template through the parser and asserts it yields `[]`.
- **Unknown columns are ignored, not rejected.** Bookkeeping columns are normal
  in a real contact list. Ignoring them is also what keeps them away from the
  DTO, whose validation runs with `forbidNonWhitelisted`.
- **exceljs is CJS with `module.exports = <identifier>`.** A named import
  type-checks and then throws at boot. Default import for values, `import type`
  for types.
- **No `FileTypeValidator`.** It sniffs magic bytes, and an `.xlsx` is a zip, so
  the honest check is the extension plus whether exceljs can read it.
- **`UploadedSpreadsheet` must stay an interface.** A class-typed
  `@UploadedFile()` parameter would be run through the global `ValidationPipe`
  and rejected by `forbidNonWhitelisted`.
- **`cell.text` is typed `string` and is not always one.** For a hyperlink whose
  display text is rich text — what Excel produces after auto-linking a typed
  email — it is an object. `readCellText` checks the type rather than trusting
  it, and unpicks `cell.value` by hand when it has to.

## Known limitations

- **Headers must be on row 1.** A sheet with a title banner above the table is
  rejected with a message listing the headers that were found.
- **Excel can lose a `+` or a leading zero before upload.** If a phone column is
  formatted as a number, `+91…` is gone by the time we see the file. The
  generated template sets that column to Text, and the Instructions sheet says
  to keep it that way; a hand-made sheet can still arrive damaged.
- **Country-code variants are different vendors.** `+919876543210` and
  `9876543210` normalise to different strings, so both can exist. Unifying them
  would need a real phone-number library and a default region.
- **A single `POST` still has a create race.** Two simultaneous creates of the
  same new number leave one of them raising the raw unique-constraint error as a
  500. Import does not have this problem — it goes through `ON CONFLICT DO
  NOTHING` — and the pre-check turns the ordinary case into a clean 409.
