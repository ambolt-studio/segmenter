import { createApp } from "./server.ts";
const port = Number(process.env.PORT ?? 3000);
const app = createApp();
app.listen(port, () => {
  console.log(`Segmenter listening on :${port}`);
});