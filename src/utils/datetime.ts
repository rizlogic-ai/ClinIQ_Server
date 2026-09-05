import { z } from "zod";

// A /^\d{2}:\d{2}$/ regex happily accepts "99:99", which Postgres then rejects
// at insert time. These validate the actual value, not just its shape.

export const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((v) => {
    const [y, m, d] = v.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const parsed = new Date(Date.UTC(y, m - 1, d));
    // Rejects roll-over dates such as 2026-02-31.
    return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
  }, "That date doesn't exist");

export const timeField = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Use the format HH:mm")
  .refine((v) => {
    const [h, m] = v.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }, "That time doesn't exist");
