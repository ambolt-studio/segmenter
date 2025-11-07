import * as cheerio from "cheerio";
import { BANK_NAMES } from "./bankNames.ts";

export function ensurePayload(obj: any) {
  const html = (typeof obj?.html === "string" ? obj.html.trim() : "");
  const text = (typeof obj?.text === "string" ? obj.text.trim() : "");
  const parsedDoc = obj?.parsed_document || obj?.document || obj;
  
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
    transaction_count?: number;
  };
};

export function extractFromParsedDocument(parsedDoc: any, max: number) {
  const chunks: Chunk[] = [];
  let idx = 1;
  
  const bankName = parsedDoc.labels?.bank || 
                   detectBankName(JSON.stringify(parsedDoc).substring(0, 5000));
  
  if (parsedDoc.pages && Array.isArray(parsedDoc.pages)) {
    for (const page of parsedDoc.pages) {
      if (!page.page_fragments) continue;
      
      const allFragments = page.page_fragments
        .sort((a: any, b: any) => a.reading_order - b.reading_order);
      
      let pageContent = "";
      let pageMetadata: any = {
        has_transactions: false,
        debit_columns: [],
        credit_columns: [],
        date_column: null,
        description_column: null,
        transaction_count: 0
      };
      
      for (const fragment of allFragments) {
        if (fragment.fragment_type === "table") {
          const tableContent = fragment.content?.content || fragment.content?.markdown || "";
          const tableMeta = analyzeTableStructure(fragment.content?.cells || [], tableContent);
          
          if (tableMeta.has_transactions) {
            pageMetadata.has_transactions = true;
            pageMetadata.debit_columns = [...new Set([...pageMetadata.debit_columns, ...tableMeta.debit_columns])];
            pageMetadata.credit_columns = [...new Set([...pageMetadata.credit_columns, ...tableMeta.credit_columns])];
            if (tableMeta.date_column) pageMetadata.date_column = tableMeta.date_column;
            if (tableMeta.description_column) pageMetadata.description_column = tableMeta.description_column;
            
            const transactionLines = tableContent.split('\n').filter((line: string) => 
              /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2})/i.test(line)
            );
            pageMetadata.transaction_count += transactionLines.length;
          }
          
          pageContent += "\n\n### TABLE ###\n" + tableContent;
        } else if (fragment.fragment_type === "text") {
          const textContent = fragment.content?.content || "";
          if (textContent.trim()) {
            pageContent += "\n" + textContent;
          }
        }
      }
      
      pageContent = pageContent.trim();
      
      if (pageContent.length <= max) {
        chunks.push({
          bank_name: bankName,
          chunk_id: `chunk_${idx}`,
          chunk_number: idx,
          char_len: pageContent.length,
          has_table: pageMetadata.has_transactions,
          chunk_text: pageContent,
          metadata: pageMetadata
        });
        idx++;
      } else {
        const tableChunks = splitLargePageContent(pageContent, max, bankName, idx, pageMetadata);
        chunks.push(...tableChunks);
        idx += tableChunks.length;
      }
    }
  }
  
  if (chunks.length === 0 && parsedDoc.chunks && Array.isArray(parsedDoc.chunks)) {
    let consolidatedContent = "";
    
    for (const chunk of parsedDoc.chunks) {
      consolidatedContent += "\n\n" + (chunk.content || "");
    }
    
    consolidatedContent = consolidatedContent.trim();
    
    if (consolidatedContent.length <= max) {
      chunks.push({
        bank_name: bankName,
        chunk_id: `chunk_${idx}`,
        chunk_number: idx,
        char_len: consolidatedContent.length,
        has_table: /\|.*\|/.test(consolidatedContent) || /\t/.test(consolidatedContent),
        chunk_text: consolidatedContent
      });
    } else {
      for (const seg of chunkify(consolidatedContent, max)) {
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

function splitLargePageContent(content: string, max: number, bankName: string, startIdx: number, metadata: any): Chunk[] {
  const chunks: Chunk[] = [];
  let idx = startIdx;
  
  const sections = content.split(/### TABLE ###/).filter(s => s.trim());
  
  let buffer = "";
  
  for (const section of sections) {
    if (buffer.length > 0 && (buffer.length + section.length) > max) {
      chunks.push({
        bank_name: bankName,
        chunk_id: `chunk_${idx}`,
        chunk_number: idx,
        char_len: buffer.length,
        has_table: /\|/.test(buffer) || metadata.has_transactions,
        chunk_text: buffer.trim(),
        metadata: metadata
      });
      idx++;
      buffer = section;
    } else {
      buffer += "\n\n" + section;
    }
  }
  
  if (buffer.trim()) {
    chunks.push({
      bank_name: bankName,
      chunk_id: `chunk_${idx}`,
      chunk_number: idx,
      char_len: buffer.length,
      has_table: /\|/.test(buffer) || metadata.has_transactions,
      chunk_text: buffer.trim(),
      metadata: metadata
    });
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
  
  const headerTexts = cells
    .filter(c => c.text)
    .map(c => c.text.toLowerCase());
  
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
  
  if (/debits.*credits|withdrawals.*deposits/i.test(content)) {
    metadata.has_transactions = true;
  }
  
  return metadata;
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
    if (/^\s*\d{2}[\/\-]\d{2}(?:[\/\-]\d{2,4})?\s+/i.test(line)) return true;
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
