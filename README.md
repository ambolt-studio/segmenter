# Segmenter Service (Bun + Express)
POST /segment with { "html": "<html>...</html>" } or { "text": "..." }.
Returns chunks with minimal stats and table detection.
See Dockerfile and package.json for quick run.
If you send neither html nor text, you'll get 400 with 'Empty payload: provide `html` or `text`'.