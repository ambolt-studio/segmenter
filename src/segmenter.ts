import { ensurePayload, extractFromHtml, extractFromText, extractFromParsedDocument } from "./utils.ts";

export function handleSegment(input: any) {
  const { html, text, parsedDoc, max } = ensurePayload(input);
  
  // Handle parsed bank statement JSON
  if (parsedDoc) {
    const { chunks, bankName, tablesDetected } = extractFromParsedDocument(parsedDoc, max);
    const totalChars = chunks.reduce((acc, c) => acc + c.char_len, 0);
    return [{
      ok: true,
      bank_name: bankName,
      stats: {
        total_chunks: chunks.length,
        total_chars: totalChars,
        avg_chunk_size: Math.round(totalChars / Math.max(chunks.length, 1)),
        tables_detected: tablesDetected
      },
      chunks
    }];
  }
  
  // Handle HTML input
  if (html) {
    const { chunks, bankName, tablesDetected } = extractFromHtml(html, max);
    const totalChars = chunks.reduce((acc, c) => acc + c.char_len, 0);
    return [{
      ok: true,
      bank_name: bankName,
      stats: {
        total_chunks: chunks.length,
        total_chars: totalChars,
        avg_chunk_size: Math.round(totalChars / Math.max(chunks.length, 1)),
        tables_detected: tablesDetected
      },
      chunks
    }];
  }
  
  // Handle plain text input
  const { chunks, bankName, tablesDetected } = extractFromText(text, max);
  const totalChars = chunks.reduce((acc, c) => acc + c.char_len, 0);
  return [{
    ok: true,
    bank_name: bankName,
    stats: {
      total_chunks: chunks.length,
      total_chars: totalChars,
      avg_chunk_size: Math.round(totalChars / Math.max(chunks.length, 1)),
      tables_detected: tablesDetected
    },
    chunks
  }];
}
