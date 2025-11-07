import * as cheerio from "cheerio";
import { BANK_NAMES } from "./bankNames.ts";

export function ensurePayload(obj: any) {
  const html = (typeof obj?.html === "string" ? obj.html.trim() : "");
  const text = (typeof obj?.text === "string" ? obj.text.trim() : "");
  if (!html && !text) {
    const err = new Error("Empty payload: provide `html` or `text`.");
    (err as any).statusCode = 400;
    throw err;
  }
  return { html, text, max: sanitizeMax(obj?.max_chars_per_chunk) };
}

function sanitizeMax(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 12000;
  return Math.min(n, 60000);
}

export function detectBankName(fullText: string): string {
  const hay = (fullText || "").toLowerCase();
  for (const name of BANK_NAMES) {
    if (hay.includes(name.toLowerCase())) return name;
  }
  return "Unknown";
}

export type Chunk = {
  bank_name?: string;
  chunk_id: string;
  chunk_number: number;
  char_len: number;
  has_table: boolean;
  chunk_text: string;
};

export function extractFromHtml(html: string, max: number) {
  const $ = cheerio.load(html);
  const tables: string[] = [];
  $("table").each((_i, el) => {
    const rows: string[] = [];
    cheerio.default(el).find("tr").each((_rIdx, tr) => {
      const cols: string[] = [];
      cheerio.default(tr).find("th,td").each((_cIdx, td) => {
        cols.push(cheerio.default(td).text().trim().replace(/\s+/g, " "));
      });
      if (cols.length) rows.push(cols.join("\t"));
    });
    const tableText = rows.join("\n").trim();
    if (tableText) tables.push(tableText);
  });

  const copy = $.root().clone();
  copy.find("table").remove();
  const nonTable = copy.text().replace(/\s+/g, " ").trim();

  const chunks: Chunk[] = [];
  let idx = 1;

  if (nonTable) {
    for (const seg of chunkify(nonTable, max)) {
      chunks.push({ chunk_id: `chunk_${idx}`, chunk_number: idx, char_len: seg.length, has_table: false, chunk_text: seg });
      idx++;
    }
  }

  for (const t of tables) {
    for (const seg of chunkify(t, max)) {
      chunks.push({ chunk_id: `chunk_${idx}`, chunk_number: idx, char_len: seg.length, has_table: true, chunk_text: seg });
      idx++;
    }
  }

  const fullTextForBank = (nonTable + " " + tables.join(" ")).trim();
  return { chunks, bankName: detectBankName(fullTextForBank), tablesDetected: tables.length };
}

export function extractFromText(text: string, max: number) {
  const blocks = splitTableLikeBlocks(text);
  const chunks: Chunk[] = [];
  let idx = 1;

  for (const b of blocks) {
    for (const seg of chunkify(b.content, max)) {
      chunks.push({ chunk_id: `chunk_${idx}`, chunk_number: idx, char_len: seg.length, has_table: b.type === "table", chunk_text: seg });
      idx++;
    }
  }

  return { chunks, bankName: detectBankName(text), tablesDetected: blocks.filter(b => b.type === "table").length };
}

export function chunkify(s: string, max: number): string[] {
  if (!s) return [];
  if (s.length <= max) return [s];

  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    let end = Math.min(start + max, s.length);
    if (end < s.length) {
      const window = s.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (lastBreak > 200) end = start + lastBreak + 1;
    }
    out.push(s.slice(start, end).trim());
    start = end;
  }
  return out.filter(Boolean);
}

type Block = { type: "table" | "text"; content: string };

export function splitTableLikeBlocks(text: string): Block[] {
  const lines = text.split(/\r?\n/);
  const blocks: Block[] = [];

  let curType: "table" | "text" | null = null;
  let buf: string[] = [];

  const isTableRow = (line: string): boolean => {
    if (/^\s*\d{2}[\/-]\d{2}(?:[\/-]\d{2,4})?\s+/i.test(line)) return true;
    if (/\t/.test(line)) return true;
    if (/(\s{2,}[^\s]+\s{2,}[^\s]+)/.test(line)) return true;
    if (/^\s*(DATE|DESCRIPTION|AMOUNT)\b/i.test(line)) return true;
    return false;
  };

  const flush = () => {
    if (!buf.length) return;
    const content = buf.join("\n").trim();
    if (!content) { buf = []; return; }
    blocks.push({ type: (curType ?? "text"), content });
    buf = [];
  };

  for (const raw of lines) {
    const l = raw ?? "";
    const rowIsTable = isTableRow(l);

    if (curType === null) {
      curType = rowIsTable ? "table" : "text";
      buf.push(l);
      continue;
    }

    if (rowIsTable && curType === "table") {
      buf.push(l);
    } else if (!rowIsTable && curType === "text") {
      buf.push(l);
    } else {
      flush();
      curType = rowIsTable ? "table" : "text";
      buf.push(l);
    }
  }
  flush();

  const merged: Block[] = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === b.type && (prev.content.length + b.content.length) < 2000) {
      prev.content = prev.content + "\n" + b.content;
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}
