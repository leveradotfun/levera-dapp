import { promises as fs } from "fs";
import path from "path";
import { CsvFile, FILENAMES, SCHEMAS } from "@/lib/csvSchema";

// Real append-only CSV files on disk, so a research run survives dev-server restarts and
// redeploys and can be opened directly in a spreadsheet or read by a script.
//
// Three files, one per shape: see `lib/csvSchema.ts` for what each holds and why they are split.
const DATA_DIR = path.join(process.cwd(), "..", "data");

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function isCsvFile(v: unknown): v is CsvFile {
  return v === "book" || v === "pools" || v === "collaterals" || v === "events";
}

/// Creates the file, and migrates it in place when its schema has changed.
///
/// Writing the header only on creation is how a file ends up describing N fields while new rows
/// carry N+k, silently shifting every value under the wrong heading from that point on. Rewriting
/// against the current schema keeps the history -- old rows hold their values by column NAME, and
/// columns that did not exist then are blank rather than guessed.
async function ensureFile(file: CsvFile): Promise<string> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, FILENAMES[file]);
  const header = SCHEMAS[file].join(",");

  let existing: string;
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch {
    await fs.writeFile(filePath, header + "\n", "utf8");
    return filePath;
  }

  const lines = existing.split("\n");
  if ((lines[0] ?? "") === header) return filePath;

  const oldColumns = parseCsvLine(lines[0] ?? "");
  const migrated = [header];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    const byName = new Map(oldColumns.map((c, i) => [c, values[i] ?? ""]));
    migrated.push(SCHEMAS[file].map((c) => csvEscape(byName.get(c) ?? "")).join(","));
  }
  await fs.writeFile(filePath, migrated.join("\n") + "\n", "utf8");
  return filePath;
}

/// Accepts one row or a batch. A pool sweep writes one row per registered launch, and sending them
/// individually would mean N round trips per interval -- which on a busy book is how a logger
/// starts contributing to the rate limiting it is supposed to be measuring.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { file?: string; rows?: unknown[]; row?: unknown };
    const file = body.file;
    if (!isCsvFile(file)) {
      return Response.json({ error: `unknown file "${body.file}"` }, { status: 400 });
    }

    const rows = (body.rows ?? (body.row ? [body.row] : [])) as Record<string, unknown>[];
    if (rows.length === 0) return Response.json({ ok: true, written: 0 });

    // Every row must be attributable. A row with no writer cannot be de-duplicated or ordered
    // against the other producers, which is exactly the state that made a third of the previous
    // dataset impossible to assign to a run.
    for (const r of rows) {
      if (!r.writer) return Response.json({ error: "row is missing `writer`" }, { status: 400 });
    }

    const filePath = await ensureFile(file);
    const columns = SCHEMAS[file];
    const payload = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(",")).join("\n") + "\n";
    await fs.appendFile(filePath, payload, "utf8");
    return Response.json({ ok: true, written: rows.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/// `/api/session-log?file=pools` serves one of the three as a real CSV download. Without a
/// `file` parameter it lists what is available rather than guessing.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file");

  if (!isCsvFile(file)) {
    return Response.json({
      files: Object.keys(FILENAMES),
      usage: "/api/session-log?file=book | pools | events",
    });
  }

  try {
    const filePath = await ensureFile(file);
    const content = await fs.readFile(filePath, "utf8");
    return new Response(content, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `inline; filename="${FILENAMES[file]}"`,
      },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/// `DELETE /api/session-log?file=pools` truncates one file back to its header, or all three
/// without a `file` parameter. Starting a research run on top of a previous deployment's rows is
/// how two incompatible books end up in one series.
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const file = url.searchParams.get("file");
  const targets: CsvFile[] = isCsvFile(file) ? [file] : ["book", "pools", "collaterals", "events"];
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    for (const t of targets) {
      await fs.writeFile(path.join(DATA_DIR, FILENAMES[t]), SCHEMAS[t].join(",") + "\n", "utf8");
    }
    return Response.json({ ok: true, cleared: targets });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
