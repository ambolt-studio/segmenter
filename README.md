# Segmenter Service (Bun + Express)

A smart document segmentation service that intelligently chunks bank statements and other documents while preserving transaction boundaries.

## Features

- **Smart Transaction Detection**: Automatically identifies and preserves transaction boundaries
- **Multi-format Support**: Handles HTML, plain text, and parsed bank statement JSON
- **Debit/Credit Intelligence**: Detects and labels debit/credit columns for LLM processing
- **Configurable Chunking**: Adjustable chunk sizes with logical break points

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
    "total_chunks": 5,
    "total_chars": 25000,
    "avg_chunk_size": 5000,
    "tables_detected": 2
  },
  "chunks": [
    {
      "bank_name": "Amerant",
      "chunk_id": "chunk_1",
      "chunk_number": 1,
      "total_chunks": 5,
      "char_len": 5000,
      "has_table": true,
      "chunk_text": "...",
      "metadata": {
        "has_transactions": true,
        "debit_columns": ["Debits", "Withdrawals"],
        "credit_columns": ["Credits", "Deposits"],
        "date_column": "Date",
        "description_column": "Description"
      }
    }
  ]
}]
```

## Key Features for Bank Statements

### Transaction Boundary Preservation
The segmenter intelligently splits tables at transaction boundaries, ensuring:
- No transactions are split across chunks
- Transaction groups stay together
- Headers are included in each chunk for context

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

## Configuration

- `max_chars_per_chunk`: Controls maximum chunk size (default: 12000, max: 60000)
- Chunks will attempt to break at logical points (paragraphs, sentences)
- Transaction tables always respect transaction boundaries regardless of size
