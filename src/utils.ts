import * as cheerio from "cheerio";
import { BANK_NAMES } from "./bankNames.ts";

export function ensurePayload(obj: any) {
  const html = (typeof obj?.html === "string" ? obj.html.trim() : "");
  const text = (typeof obj?.text === "string" ? obj.text.trim() : "");
  const parsedDoc = obj?.parsed_document || obj?.document || obj;
  
  // Check if it's a parsed bank statement document
  if (parsedDoc && (parsedDoc.pages || parsedDoc.chunks)) {
    return { 
      html, 
      text, 
      parsedDoc, 
      max: sanitizeMax(obj?.max_chars_per_chunk) 
    };
  }
  
  if (!html && !text) {
    const err = new Error("Empty payload: provide `html`, `text`, or `parsed_document`.");
    (err as any).statusCode = 400;
    throw err;
  }
  return { html, text, parsedDoc: null, max: sanitizeMax(obj?.max_chars_per_chunk) };
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
  total_chunks?: number;
  char_len: number;
  has_table: boolean;
  chunk_text: string;
  metadata?: {
    has_transactions?: boolean;
    debit_columns?: string[];
    credit_columns?: string[];
    date_column?: string;
    description_column?: string;
  };
};

export function extractFromParsedDocument(parsedDoc: any, max: number) {
  const chunks: Chunk[] = [];
  let idx = 1;
  
  // Extract bank name from labels or content
  const bankName = parsedDoc.labels?.bank || 
                   detectBankName(JSON.stringify(parsedDoc).substring(0, 5000));
  
  // Process pages with fragments
  if (parsedDoc.pages && Array.isArray(parsedDoc.pages)) {
    for (const page of parsedDoc.pages) {
      if (!page.page_fragments) continue;
      
      // Group fragments by type and process tables specially
      const tables: any[] = [];
      const texts: any[] = [];
      
      for (const fragment of page.page_fragments) {
        if (fragment.fragment_type === "table") {
          tables.push(fragment);
        } else if (fragment.fragment_type === "text") {
          texts.push(fragment);
        }
      }
      
      // Process non-table text
      const nonTableText = texts
        .sort((a, b) => a.reading_order - b.reading_order)
        .map(f => f.content?.content || "")
        .join("\n")
        .trim();
      
      if (nonTableText) {
        for (const seg of chunkify(nonTableText, max)) {
          chunks.push({
            bank_name: bankName,
            chunk_id: `chunk_${idx}`,
            chunk_number: idx,
            char_len: seg.length,
            has_table: false,
            chunk_text: seg
          });
          idx++;
        }
      }
      
      // Process tables with transaction intelligence
      for (const table of tables) {
        const tableChunks = processTableFragment(table, idx, max, bankName);
        chunks.push(...tableChunks);
        idx += tableChunks.length;
      }
    }
  }
  
  // Fallback: process chunks if pages aren't available
  if (chunks.length === 0 && parsedDoc.chunks && Array.isArray(parsedDoc.chunks)) {
    for (const chunk of parsedDoc.chunks) {
      const content = chunk.content || "";
      for (const seg of chunkify(content, max)) {
        chunks.push({
          bank_name: bankName,
          chunk_id: `chunk_${idx}`,
          chunk_number: idx,
          char_len: seg.length,
          has_table: /\|.*\|/.test(seg) || /\t/.test(seg),
          chunk_text: seg
        });
        idx++;
      }
    }
  }
  
  // Add total_chunks to all chunks
  const totalChunks = chunks.length;
  chunks.forEach(c => c.total_chunks = totalChunks);
  
  return { 
    chunks, 
    bankName, 
    tablesDetected: parsedDoc.pages?.reduce((sum: number, p: any) => 
      sum + (p.page_fragments?.filter((f: any) => f.fragment_type === "table").length || 0), 0
    ) || 0
  };
}

function processTableFragment(table: any, startIdx: number, max: number, bankName: string): Chunk[] {
  const chunks: Chunk[] = [];
  let idx = startIdx;
  
  // Parse table structure
  const cells = table.content?.cells || [];
  const markdown = table.content?.markdown || "";
  const content = table.content?.content || markdown;
  
  // Detect column types
  const metadata = analyzeTableStructure(cells, content);
  
  // Split table into transaction groups
  const transactionGroups = splitTableByTransactions(content, metadata);
  
  for (const group of transactionGroups) {
    // Don't split transactions across chunks
    if (group.length <= max) {
      chunks.push({
        bank_name: bankName,
        chunk_id: `chunk_${idx}`,
        chunk_number: idx,
        char_len: group.length,
        has_table: true,
        chunk_text: group,
        metadata
      });
      idx++;
    } else {
      // If a single transaction group is too large, chunk it carefully
      for (const seg of chunkify(group, max)) {
        chunks.push({
          bank_name: bankName,
          chunk_id: `chunk_${idx}`,
          chunk_number: idx,
          char_len: seg.length,
          has_table: true,
          chunk_text: seg,
          metadata
        });
        idx++;
      }
    }
  }
  
  return chunks;
}

function analyzeTableStructure(cells: any[], content: string): any {
  const metadata: any = {
    has_transactions: false,
    debit_columns: [],
    credit_columns: [],
    date_column: null,
    description_column: null
  };
  
  // Look for headers in cells
  const headerTexts = cells
    .filter(c => c.text)
    .map(c => c.text.toLowerCase());
  
  // Detect column types from headers
  for (const text of headerTexts) {
    if (/date/i.test(text)) {
      metadata.date_column = text;
      metadata.has_transactions = true;
    }
    if (/description|concept|detail/i.test(text)) {
      metadata.description_column = text;
    }
    if (/debit|withdrawal|out|payment/i.test(text)) {
      metadata.debit_columns.push(text);
      metadata.has_transactions = true;
    }
    if (/credit|deposit|in|income/i.test(text)) {
      metadata.credit_columns.push(text);
      metadata.has_transactions = true;
    }
  }
  
  // Also check content for common patterns
  if (/debits.*credits|withdrawals.*deposits/i.test(content)) {
    metadata.has_transactions = true;
  }
  
  return metadata;
}

function splitTableByTransactions(content: string, metadata: any): string[] {
  if (!metadata.has_transactions) {
    return [content];
  }
  
  const lines = content.split('\n');
  const groups: string[] = [];
  let currentGroup: string[] = [];
  let headerLines: string[] = [];
  
  // Find header rows
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (/date|description|amount|debit|credit/i.test(line)) {
      headerLines.push(line);
    } else {
      break;
    }
  }
  
  const startDataIdx = headerLines.length;
  
  // Process data rows
  for (let i = startDataIdx; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this looks like a transaction row (has date pattern)
    const isTransactionRow = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2})/i.test(line);
    const isEmpty = !line.trim() || /^[\|\-\s]+$/.test(line);
    
    if (isEmpty && currentGroup.length > 0) {
      // Empty line might separate transactions
      const groupText = [...headerLines, ...currentGroup].join('\n');
      if (groupText.trim()) {
        groups.push(groupText);
      }
      currentGroup = [];
    } else if (isTransactionRow) {
      // Start of a new transaction - flush previous
      if (currentGroup.length > 0) {
        const groupText = [...headerLines, ...currentGroup].join('\n');
        if (groupText.trim()) {
          groups.push(groupText);
        }
      }
      currentGroup = [line];
    } else if (currentGroup.length > 0) {
      // Continuation of current transaction
      currentGroup.push(line);
    } else {
      currentGroup.push(line);
    }
  }
  
  // Flush remaining
  if (currentGroup.length > 0) {
    const groupText = [...headerLines, ...currentGroup].join('\n');
    if (groupText.trim()) {
      groups.push(groupText);
    }
  }
  
  return groups.length > 0 ? groups : [content];
}

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
      chunks.push({ 
        chunk_id: `chunk_${idx}`, 
        chunk_number: idx, 
        char_len: seg.length, 
        has_table: false, 
        chunk_text: seg 
      });
      idx++;
    }
  }

  for (const t of tables) {
    for (const seg of chunkify(t, max)) {
      chunks.push({ 
        chunk_id: `chunk_${idx}`, 
        chunk_number: idx, 
        char_len: seg.length, 
        has_table: true, 
        chunk_text: seg 
      });
      idx++;
    }
  }

  const totalChunks = chunks.length;
  chunks.forEach(c => c.total_chunks = totalChunks);

  const fullTextForBank = (nonTable + " " + tables.join(" ")).trim();
  return { chunks, bankName: detectBankName(fullTextForBank), tablesDetected: tables.length };
}

export function extractFromText(text: string, max: number) {
  const blocks = splitTableLikeBlocks(text);
  const chunks: Chunk[] = [];
  let idx = 1;

  for (const b of blocks) {
    for (const seg of chunkify(b.content, max)) {
      chunks.push({ 
        chunk_id: `chunk_${idx}`, 
        chunk_number: idx, 
        char_len: seg.length, 
        has_table: b.type === "table", 
        chunk_text: seg 
      });
      idx++;
    }
  }

  const totalChunks = chunks.length;
  chunks.forEach(c => c.total_chunks = totalChunks);

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
