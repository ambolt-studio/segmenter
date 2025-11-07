import { detectBankName } from "./utils.ts";

export type ParsedDocument = {
  parse_id?: string;
  parsed_pages_count?: number;
  total_pages?: number;
  status?: string;
  pages?: any[];
  chunks?: Array<{ content: string; page_number?: number }>;
  labels?: {
    client_id?: string;
    bank?: string;
    source?: string;
  };
};

export type Transaction = {
  date: string;
  description: string;
  amount: number;
  type: "debit" | "credit" | "unknown";
  balance?: number;
  raw_text: string;
};

export type ProcessedChunk = {
  chunk_id: string;
  chunk_number: number;
  total_chunks: number;
  char_len: number;
  has_table: boolean;
  bank_name: string;
  chunk_text: string;
  transactions?: Transaction[];
  metadata?: {
    page_number?: number;
    contains_summary?: boolean;
    contains_header?: boolean;
  };
};

/**
 * Detecta el formato de transacciones en el texto
 */
function detectTransactionFormat(text: string): {
  hasDebitCredit: boolean;
  hasSignedAmounts: boolean;
  datePattern: RegExp | null;
} {
  const lines = text.split('\n').filter(l => l.trim());
  
  // Buscar columnas Debits/Credits
  const hasDebitCredit = /\b(debits?|credits?)\b/i.test(text);
  
  // Buscar montos con signo negativo
  const hasSignedAmounts = /-\$[\d,]+\.?\d*/g.test(text);
  
  // Detectar patrones de fecha
  let datePattern: RegExp | null = null;
  if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/i.test(text)) {
    datePattern = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/i;
  } else if (/\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/.test(text)) {
    datePattern = /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/;
  } else if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) {
    datePattern = /\b\d{4}-\d{2}-\d{2}\b/;
  }
  
  return { hasDebitCredit, hasSignedAmounts, datePattern };
}

/**
 * Extrae transacciones de una tabla
 */
function extractTransactionsFromTable(tableText: string): Transaction[] {
  const transactions: Transaction[] = [];
  const format = detectTransactionFormat(tableText);
  
  // Dividir en líneas y filtrar vacías
  const lines = tableText.split('\n').filter(l => l.trim());
  
  // Saltar líneas de encabezado
  let startIdx = 0;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    if (/\b(date|description|amount|debit|credit|balance)\b/i.test(lines[i])) {
      startIdx = i + 1;
    }
  }
  
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Saltar líneas de totales o resumen
    if (/\b(total|subtotal|ending balance|beginning balance)\b/i.test(line)) {
      continue;
    }
    
    // Buscar fecha
    if (!format.datePattern) continue;
    const dateMatch = line.match(format.datePattern);
    if (!dateMatch) continue;
    
    const date = dateMatch[0];
    
    // Extraer montos (buscar todos los números con formato de moneda)
    const amounts = line.match(/-?\$?[\d,]+\.?\d*/g)
      ?.map(a => parseFloat(a.replace(/[$,]/g, '')))
      .filter(n => !isNaN(n) && n !== 0) || [];
    
    if (amounts.length === 0) continue;
    
    // Determinar tipo de transacción
    let type: "debit" | "credit" | "unknown" = "unknown";
    let amount = 0;
    let balance: number | undefined;
    
    if (format.hasDebitCredit) {
      // Formato con columnas Debits/Credits
      const debitMatch = line.match(/-\$?([\d,]+\.?\d*)/);
      const creditMatch = line.match(/(?<![-.])(\$?([\d,]+\.?\d*))/);
      
      if (debitMatch) {
        type = "debit";
        amount = Math.abs(parseFloat(debitMatch[1].replace(/,/g, '')));
      } else if (creditMatch && amounts.length > 0) {
        // Si hay múltiples montos, el último suele ser el balance
        if (amounts.length >= 2) {
          type = "credit";
          amount = amounts[0];
          balance = amounts[amounts.length - 1];
        } else {
          type = "credit";
          amount = amounts[0];
        }
      }
    } else if (format.hasSignedAmounts) {
      // Formato con montos con signo
      const negativeAmount = amounts.find(a => a < 0);
      if (negativeAmount) {
        type = "debit";
        amount = Math.abs(negativeAmount);
      } else if (amounts.length > 0) {
        type = "credit";
        amount = amounts[0];
      }
      
      if (amounts.length > 1) {
        balance = amounts[amounts.length - 1];
      }
    } else {
      // Formato sin información clara, intentar deducir
      if (amounts.length >= 2) {
        // Asumir: primer monto es la transacción, último es el balance
        amount = Math.abs(amounts[0]);
        balance = amounts[amounts.length - 1];
        
        // Intentar detectar palabras clave para determinar tipo
        if (/\b(deposit|credit|incoming|wire in)\b/i.test(line)) {
          type = "credit";
        } else if (/\b(withdrawal|debit|outgoing|wire out|payment|fee|charge)\b/i.test(line)) {
          type = "debit";
        }
      } else {
        amount = Math.abs(amounts[0]);
      }
    }
    
    // Extraer descripción (todo entre la fecha y los montos)
    let description = line
      .replace(dateMatch[0], '')
      .replace(/-?\$?[\d,]+\.?\d*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (!description) description = "Transaction";
    
    transactions.push({
      date,
      description,
      amount,
      type,
      balance,
      raw_text: line
    });
  }
  
  return transactions;
}

/**
 * Identifica si un bloque de texto es una tabla de transacciones
 */
function isTransactionTable(text: string): boolean {
  const hasDateColumn = /\b(date|fecha)\b/i.test(text);
  const hasAmountColumn = /\b(amount|monto|debit|credit|balance)\b/i.test(text);
  const hasMultipleRows = text.split('\n').length >= 3;
  const hasTabularFormat = /\|/.test(text) || /\t/.test(text) || text.includes('---');
  
  return (hasDateColumn || hasAmountColumn) && hasMultipleRows && hasTabularFormat;
}

/**
 * Divide el contenido en chunks lógicos preservando transacciones
 */
function createLogicalChunks(
  content: string,
  maxChunkSize: number = 12000
): Array<{ text: string; isTable: boolean; transactions: Transaction[] }> {
  const chunks: Array<{ text: string; isTable: boolean; transactions: Transaction[] }> = [];
  
  // Dividir por tablas markdown
  const sections = content.split(/(?=\n\|[^\n]+\|\n\|[\s\-|]+\|)/);
  
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    
    const isTable = isTransactionTable(trimmed);
    let transactions: Transaction[] = [];
    
    if (isTable) {
      transactions = extractTransactionsFromTable(trimmed);
    }
    
    // Si la sección es muy grande, dividirla por transacciones
    if (trimmed.length > maxChunkSize && transactions.length > 0) {
      let currentChunk = '';
      let currentTransactions: Transaction[] = [];
      
      // Extraer encabezado de tabla si existe
      const headerMatch = trimmed.match(/^[\s\S]*?\n\|[\s\-|]+\|\n/);
      const header = headerMatch ? headerMatch[0] : '';
      
      for (const transaction of transactions) {
        const transactionText = transaction.raw_text + '\n';
        
        if ((currentChunk + transactionText).length > maxChunkSize && currentChunk.length > 0) {
          // Guardar chunk actual
          chunks.push({
            text: header + currentChunk.trim(),
            isTable: true,
            transactions: currentTransactions
          });
          
          // Iniciar nuevo chunk
          currentChunk = transactionText;
          currentTransactions = [transaction];
        } else {
          currentChunk += transactionText;
          currentTransactions.push(transaction);
        }
      }
      
      // Guardar último chunk
      if (currentChunk.trim()) {
        chunks.push({
          text: header + currentChunk.trim(),
          isTable: true,
          transactions: currentTransactions
        });
      }
    } else {
      // Sección pequeña o sin transacciones, guardar completa
      chunks.push({
        text: trimmed,
        isTable,
        transactions
      });
    }
  }
  
  return chunks;
}

/**
 * Procesa un documento parseado y genera chunks optimizados
 */
export function processDocument(doc: ParsedDocument, maxChunkSize: number = 12000): ProcessedChunk[] {
  const allChunks: ProcessedChunk[] = [];
  
  // Detectar banco
  const bankName = doc.labels?.bank || 
    detectBankName(doc.chunks?.[0]?.content || '') || 
    'Unknown';
  
  // Procesar cada chunk del documento original
  if (doc.chunks && doc.chunks.length > 0) {
    for (const docChunk of doc.chunks) {
      const content = docChunk.content || '';
      const pageNumber = docChunk.page_number;
      
      // Crear chunks lógicos
      const logicalChunks = createLogicalChunks(content, maxChunkSize);
      
      for (const chunk of logicalChunks) {
        const chunkNumber = allChunks.length + 1;
        
        allChunks.push({
          chunk_id: `chunk_${chunkNumber}`,
          chunk_number: chunkNumber,
          total_chunks: 0, // Se actualizará después
          char_len: chunk.text.length,
          has_table: chunk.isTable,
          bank_name: bankName,
          chunk_text: chunk.text,
          transactions: chunk.transactions.length > 0 ? chunk.transactions : undefined,
          metadata: {
            page_number: pageNumber,
            contains_summary: /\b(summary|resumen|balance|total)\b/i.test(chunk.text),
            contains_header: /\b(account|statement|date)\b/i.test(chunk.text.substring(0, 200))
          }
        });
      }
    }
  }
  
  // Actualizar total_chunks en todos los chunks
  const totalChunks = allChunks.length;
  allChunks.forEach(chunk => {
    chunk.total_chunks = totalChunks;
  });
  
  return allChunks;
}
