import { Hono } from "hono";
import { randomUUID } from "crypto";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq, and, sql, desc } from "drizzle-orm";
import { agentAuth } from "../middleware/auth.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();
app.use("/*", agentAuth);

const VALID_SENTIMENTS = ["bullish", "bearish", "neutral"];

// ─── GET /journal — list all notes, optionally filtered ───

app.get("/", (c) => {
  const agentId = c.get("agentId") as string;
  const positionId = c.req.query("position_id");
  const tag = c.req.query("tag");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);

  let query = db.select().from(schema.tradeNotes)
    .where(eq(schema.tradeNotes.agentId, agentId))
    .orderBy(desc(schema.tradeNotes.createdAt))
    .limit(limit);

  let notes = query.all();

  // Filter by position_id if provided
  if (positionId) {
    notes = notes.filter(n => n.positionId === positionId);
  }

  // Filter by tag if provided
  if (tag) {
    const tagLower = tag.toLowerCase();
    notes = notes.filter(n => n.tags?.toLowerCase().split(",").map(t => t.trim()).includes(tagLower));
  }

  // Enrich with position summary where available
  const enriched = notes.map(n => {
    let position = null;
    if (n.positionId) {
      const pos = db.select({
        coin: schema.positions.coin,
        side: schema.positions.side,
        status: schema.positions.status,
        entryPrice: schema.positions.entryPrice,
        sizeUsd: schema.positions.sizeUsd,
      }).from(schema.positions)
        .where(eq(schema.positions.id, n.positionId))
        .get();
      if (pos) position = pos;
    }
    return {
      id: n.id,
      position_id: n.positionId ?? null,
      position,
      note: n.note,
      tags: n.tags ? n.tags.split(",").map(t => t.trim()).filter(Boolean) : [],
      sentiment: n.sentiment ?? null,
      created_at: n.createdAt,
      updated_at: n.updatedAt,
    };
  });

  // Tag cloud
  const allTags: Record<string, number> = {};
  for (const n of enriched) {
    for (const t of n.tags) {
      allTags[t] = (allTags[t] ?? 0) + 1;
    }
  }

  return c.json({
    notes: enriched,
    count: enriched.length,
    tag_cloud: allTags,
    tip: "Tag notes with comma-separated tags (e.g., 'momentum,earnings,breakout') for easy filtering",
  });
});

// ─── POST /journal — create a note ───

app.post("/", async (c) => {
  const agentId = c.get("agentId") as string;
  const body = await c.req.json().catch(() => ({}));

  const note = (body.note as string)?.trim();
  const positionId = (body.position_id as string) || null;
  const tags = (body.tags as string)?.toLowerCase().replace(/\s+/g, "").slice(0, 500) || null;
  const sentiment = (body.sentiment as string)?.toLowerCase() || null;

  if (!note || note.length < 1) {
    return c.json({ error: "missing_note", message: "Provide { note: '...' }" }, 400);
  }
  if (note.length > 5000) {
    return c.json({ error: "note_too_long", message: "Notes are limited to 5,000 characters" }, 400);
  }
  if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
    return c.json({ error: "invalid_sentiment", message: `sentiment must be: ${VALID_SENTIMENTS.join("|")}` }, 400);
  }

  // Verify position belongs to this agent if provided
  if (positionId) {
    const pos = db.select({ id: schema.positions.id })
      .from(schema.positions)
      .where(and(eq(schema.positions.id, positionId), eq(schema.positions.agentId, agentId)))
      .get();
    if (!pos) {
      return c.json({ error: "position_not_found", message: "Position not found or does not belong to you" }, 404);
    }
  }

  const id = `jn_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const now = Math.floor(Date.now() / 1000);

  db.insert(schema.tradeNotes).values({
    id, agentId, positionId, note, tags, sentiment,
    createdAt: now, updatedAt: now,
  }).run();

  return c.json({
    id,
    position_id: positionId,
    note,
    tags: tags ? tags.split(",").filter(Boolean) : [],
    sentiment,
    created_at: now,
    message: "Journal entry added",
    view: "GET /v1/journal",
  }, 201);
});

// ─── PATCH /journal/:id — update a note ───

app.patch("/:id", async (c) => {
  const agentId = c.get("agentId") as string;
  const noteId = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));

  const existing = db.select().from(schema.tradeNotes)
    .where(and(eq(schema.tradeNotes.id, noteId), eq(schema.tradeNotes.agentId, agentId)))
    .get();

  if (!existing) {
    return c.json({ error: "not_found", message: "Journal entry not found" }, 404);
  }

  const note = (body.note as string)?.trim() ?? existing.note;
  const tags = body.tags !== undefined
    ? (body.tags as string)?.toLowerCase().replace(/\s+/g, "").slice(0, 500) || null
    : existing.tags;
  const sentiment = body.sentiment !== undefined
    ? (body.sentiment as string)?.toLowerCase() || null
    : existing.sentiment;

  if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
    return c.json({ error: "invalid_sentiment", message: `sentiment must be: ${VALID_SENTIMENTS.join("|")}` }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  db.update(schema.tradeNotes)
    .set({ note, tags, sentiment, updatedAt: now })
    .where(eq(schema.tradeNotes.id, noteId))
    .run();

  return c.json({ id: noteId, note, tags: tags ? tags.split(",").filter(Boolean) : [], sentiment, updated_at: now, message: "Journal entry updated" });
});

// ─── DELETE /journal/:id — delete a note ───

app.delete("/:id", (c) => {
  const agentId = c.get("agentId") as string;
  const noteId = c.req.param("id");

  const existing = db.select({ id: schema.tradeNotes.id })
    .from(schema.tradeNotes)
    .where(and(eq(schema.tradeNotes.id, noteId), eq(schema.tradeNotes.agentId, agentId)))
    .get();

  if (!existing) {
    return c.json({ error: "not_found", message: "Journal entry not found" }, 404);
  }

  db.delete(schema.tradeNotes)
    .where(eq(schema.tradeNotes.id, noteId))
    .run();

  return c.json({ message: `Journal entry ${noteId} deleted` });
});

export default app;
