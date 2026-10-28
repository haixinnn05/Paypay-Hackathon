import type { NextFunction, Request, Response } from "express";

// Small in-memory limits so a public demo can't run through the AI credit. Per visitor (IP) per
// window, plus one daily ceiling across everyone. Resets on restart, which is fine for a demo.

const WINDOW_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function rateLimit(name: string, perVisitor: number, perDay: number) {
  const hits = new Map<string, number[]>();
  let day = { start: Date.now(), count: 0 };

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - day.start > DAY_MS) day = { start: now, count: 0 };
    const ip = req.ip ?? "unknown";
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);

    if (day.count >= perDay) {
      return res.status(429).json({ error: `The demo's daily ${name} limit is used up. Try again tomorrow, or run it locally.` });
    }
    if (recent.length >= perVisitor) {
      return res.status(429).json({ error: `Too many ${name} requests. Please wait a few minutes.` });
    }
    recent.push(now);
    hits.set(ip, recent);
    day.count += 1;
    next();
  };
}
