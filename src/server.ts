import express from "express";
import { handleSegment } from "./segmenter.ts";
export function createApp() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, status: "healthy" }));
  app.post("/segment", (req, res) => {
    try {
      const out = handleSegment(req.body);
      res.json(out);
    } catch (err: any) {
      const status = err?.statusCode ?? 400;
      const message = err?.message ?? "Unhandled error";
      res.status(status).json([{ ok: false, error: message }]);
    }
  });
  return app;
}