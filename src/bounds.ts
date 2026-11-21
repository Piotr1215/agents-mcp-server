// Size and shape limits for tool inputs and results. Hosts cut or spill large
// tool results (Claude Code spills above 50,000 chars, Codex cuts the middle),
// so every history result stays under one budget with an explicit omission note.
import { z } from "zod";

export const MAX_LIMIT = 500;
export const MAX_RESULT_CHARS = 45_000;
// Room for the header, the omission note and the `_meta` block that withMeta adds.
const RESERVED_CHARS = 1_500;
export const MAX_MESSAGE_CHARS = 10_000;

// Integer 1..500 with a per-tool default.
export const limitSchema = (fallback: number) =>
  z.number().int().min(1).max(MAX_LIMIT).optional().default(fallback);

export const sinceIdSchema = z.number().int().min(0).optional().default(0);

// One oversized message must not crowd out the rest of the page.
export function clipContent(content: string): string {
  if (content.length <= MAX_MESSAGE_CHARS) return content;
  return `${content.slice(0, MAX_MESSAGE_CHARS)}... [clipped ${content.length - MAX_MESSAGE_CHARS} chars]`;
}

export interface Fit<T> { kept: T[]; omitted: number; }

// Keep as many items as fit, from `end` of the list. `newest` takes the tail of
// a chronological list; `oldest` takes the head. Output order is unchanged.
export function fitToBudget<T>(items: T[], size: (item: T) => number, end: "newest" | "oldest"): Fit<T> {
  const budget = MAX_RESULT_CHARS - RESERVED_CHARS;
  const ordered = end === "newest" ? [...items].reverse() : items;
  const kept: T[] = [];
  let used = 0;
  for (const item of ordered) {
    const cost = size(item) + 1;
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(item);
    used += cost;
  }
  if (end === "newest") kept.reverse();
  return { kept, omitted: items.length - kept.length };
}
