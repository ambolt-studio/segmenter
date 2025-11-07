# Segmenter Service (Bun + Express)

A smart document segmentation service that intelligently chunks bank statements and other documents while preserving transaction boundaries and consolidating pages for efficient LLM processing.

## Features

- **Intelligent Page Consolidation**: Automatically groups multiple pages into optimal chunks
- **Smart Transaction Detection**: Preserves transaction boundaries across pages
- **Multi-format Support**: Handles HTML, plain text, and parsed bank statement JSON
- **Debit/Credit Intelligence**: Detects and labels debit/credit columns for LLM processing
- **Configurable Chunking**: Adjustable chunk sizes with logical break points
- **Efficient Processing**: 63-page document → ~5-10 chunks instead of 63

## API Endpoints

### POST /segment

Accepts documents in three formats:

#### 1. HTML Format
```json
{
  "html": "<html>...</html>",
  "max_chars_per_chunk": 12000
}
```

#### 2. Plain Text Format
```json
{
  "text": "document content here...",
  "max_chars_per_chunk": 12000
}
```

#### 3. Parsed Bank Statement JSON
```json
{
  "parsed_document": {
    "pages": [...],
    "chunks": [...],
    "labels": {
      "bank": "Amerant"
    }
  },
  "max_chars_per_chunk": 12000
}
```

Or directly send the parsed document structure at the root level.

### Response Format

```json
[{
  "ok": true,
  "bank_name": "Amerant",
  "stats": {
    "total_chunks": 3,
    "total_chars": 35000,
    "avg_chunk_size": 11666,
    "tables_detected": 5
  },
  "chunks": [
    {
      "bank_name": "Amerant",
      "chunk_id": "chunk_1",
      "chunk_number": 1,
      "total_chunks": 3,
      "page_range": "1-4",
      "char_len": 11800,
      "has_table": true,
      "chunk_text": "...",
      "metadata": {
        "has_transactions": true,
        "debit_columns": ["Debits", "Withdrawals"],
        "credit_columns": ["Credits", "Deposits"],
        "date_column": "Date",
        "description_column": "Description",
        "transaction_count": 45
      }
    }
  ]
}]
```

## Key Features for Bank Statements

### Intelligent Page Consolidation
The segmenter groups multiple pages into chunks based on:
- **Content size**: Fills chunks up to `max_chars_per_chunk` limit
- **Transaction continuity**: Keeps related transactions together
- **Semantic breaks**: Respects logical document sections

**Example**: A 63-page bank statement becomes ~5-10 chunks instead of 63 separate API calls to your LLM.

### Transaction Boundary Preservation
- No transactions split across chunks
- Transaction groups stay together
- Headers included in each chunk for context
- Page breaks clearly marked: `--- PAGE BREAK ---`

### Debit/Credit Detection
Automatically detects various formats:
- **Separate columns**: Debits | Credits
- **Signed values**: All in one column with +/-
- **Withdrawal/Deposit**: Alternative naming conventions
- **In/Out**: Common in some banks

The metadata helps LLMs understand:
- Which columns contain debit vs credit information
- Whether values are signed or in separate columns
- Column names for accurate extraction
- Total transaction count per chunk

### Page Range Tracking
Each chunk includes `page_range` field:
- Single page: `"page_range": "5"`
- Multiple pages: `"page_range": "5-12"`

Useful for debugging and reference back to source document.

## Performance Examples

| Document | Pages | Default Chunks | With 30K limit |
|----------|-------|---------------|----------------|
| Small statement | 4 | 1-2 | 1 |
| Medium statement | 20 | 3-5 | 2-3 |
| Large statement | 63 | 8-12 | 4-6 |

## Configuration

### max_chars_per_chunk
Controls maximum chunk size (default: 12000, max: 60000)

**Recommendations:**
- **12,000**: Good balance, ~2-3 pages per chunk
- **20,000**: Fewer chunks, ~4-5 pages per chunk
- **30,000**: Aggressive consolidation, ~8-10 pages per chunk
- **50,000+**: Maximum consolidation, use for very efficient processing

**Trade-offs:**
- Larger chunks = Fewer API calls but more tokens per call
- Smaller chunks = More granular but more API calls
- The chunker intelligently breaks at natural boundaries regardless of size

## Running the Service

### Using Docker
```bash
docker build -t segmenter .
docker run -p 3000:3000 segmenter
```

### Local Development
```bash
bun install
bun run src/index.ts
```

## Error Handling

If you send neither `html`, `text`, nor a valid parsed document structure, you'll get:
```json
{
  "ok": false,
  "error": "Empty payload: provide `html`, `text`, or `parsed_document`."
}
```

## Supported Banks

Currently detects: Bank of America, Chase, Wells Fargo, Citi, Capital One, TD Bank, HSBC, Amerant, and 20+ more.

## Advanced Usage

### Optimizing for Large Documents

For very large documents (100+ pages):
```json
{
  "parsed_document": { ... },
  "max_chars_per_chunk": 40000
}
```

This will create fewer, larger chunks that maintain all transaction context while minimizing API calls.

### Header/Footer Filtering

The segmenter automatically filters common headers and footers:
- Page numbers ("Page 1 of 3")
- Document codes
- "Member FDIC"
- "Continued on next page"
- Statement dates and account numbers in headers

## Technical Details

### Chunking Algorithm
1. **Extract** all content from each page
2. **Analyze** tables for transaction patterns
3. **Consolidate** pages sequentially until approaching size limit
4. **Break** at page boundaries when limit would be exceeded
5. **Merge** metadata from all pages in chunk

### Transaction Detection
Identifies transactions by:
- Date patterns (MM/DD/YYYY, Month DD, etc.)
- Column headers (Date, Description, Amount, Debits, Credits)
- Table structure analysis
- Content pattern matching

### Metadata Aggregation
When multiple pages are consolidated:
- Debit/credit columns are collected and deduplicated
- Transaction counts are summed
- Date and description columns from first occurrence are used
- All metadata reflects the entire chunk content
