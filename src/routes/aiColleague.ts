import { randomUUID } from "crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { safeRouter } from "../utils/safeRouter";
import { requireAuth, requireRole } from "../middleware/auth";
import { askColleague, ColleagueError, isColleagueConfigured, type ChatTurn } from "../services/aiColleague";

const router = safeRouter();
// Clinical decision support is for the treating clinician only.
router.use(requireAuth, requireRole("doctor"));

const DAILY_QUESTION_LIMIT = Number(process.env.AI_DAILY_LIMIT || 50);
// Enough back-and-forth to be useful without the prompt growing unbounded.
const CONTEXT_TURNS = 12;

const askSchema = z.object({ question: z.string().trim().min(4).max(4000) });

router.get("/status", async (_req, res) => {
  res.json({ configured: isColleagueConfigured(), dailyLimit: DAILY_QUESTION_LIMIT });
});

router.get("/threads", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.title, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM cliniq.ai_messages m WHERE m.thread_id = t.id) AS message_count
     FROM cliniq.ai_threads t
     WHERE t.doctor_id = $1
     ORDER BY t.updated_at DESC`,
    [req.user!.sub]
  );
  res.json({
    threads: rows.map((r) => ({
      id: r.id,
      title: r.title,
      messageCount: r.message_count,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
  });
});

router.get("/threads/:id", async (req, res) => {
  const thread = await ownedThread(req.params.id, req.user!.sub);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  res.json({ thread: { id: thread.id, title: thread.title }, messages: await messagesFor(thread.id) });
});

router.delete("/threads/:id", async (req, res) => {
  const thread = await ownedThread(req.params.id, req.user!.sub);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  await pool.query(`DELETE FROM cliniq.ai_threads WHERE id = $1`, [thread.id]);
  res.json({ deleted: true });
});

// Start a new conversation.
router.post("/threads", async (req, res) => {
  if (!isColleagueConfigured()) {
    return res.status(503).json({ error: "The AI colleague is not configured yet." });
  }
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Write a question of at least a few words." });
  }
  const overLimit = await exceededDailyLimit(req.user!.sub);
  if (overLimit) return res.status(429).json({ error: dailyLimitMessage() });

  const question = parsed.data.question;
  const threadId = randomUUID();
  await pool.query(
    `INSERT INTO cliniq.ai_threads (id, doctor_id, title) VALUES ($1, $2, $3)`,
    [threadId, req.user!.sub, titleFrom(question)]
  );

  return await exchange(threadId, question, res);
});

// Continue an existing one.
router.post("/threads/:id/messages", async (req, res) => {
  const thread = await ownedThread(req.params.id, req.user!.sub);
  if (!thread) return res.status(404).json({ error: "Conversation not found" });
  if (!isColleagueConfigured()) {
    return res.status(503).json({ error: "The AI colleague is not configured yet." });
  }

  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Write a question of at least a few words." });
  }
  const overLimit = await exceededDailyLimit(req.user!.sub);
  if (overLimit) return res.status(429).json({ error: dailyLimitMessage() });

  return await exchange(thread.id, parsed.data.question, res);
});

/** Records the question, asks the model, records the answer. */
async function exchange(threadId: string, question: string, res: import("express").Response) {
  const prior = await messagesFor(threadId);
  const turns: ChatTurn[] = [
    ...prior.slice(-CONTEXT_TURNS).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: question },
  ];

  await pool.query(
    `INSERT INTO cliniq.ai_messages (id, thread_id, role, content) VALUES ($1, $2, 'user', $3)`,
    [randomUUID(), threadId, question]
  );

  let reply;
  try {
    reply = await askColleague(turns);
  } catch (err) {
    // The question is already saved, so the doctor doesn't lose what they typed.
    const status = err instanceof ColleagueError ? err.status : 502;
    const message = err instanceof ColleagueError ? err.message : "The AI colleague could not answer that.";
    return res.status(status).json({ error: message, threadId });
  }

  await pool.query(
    `INSERT INTO cliniq.ai_messages (id, thread_id, role, content, model) VALUES ($1, $2, 'assistant', $3, $4)`,
    [randomUUID(), threadId, reply.text, reply.model]
  );
  await pool.query(`UPDATE cliniq.ai_threads SET updated_at = now() WHERE id = $1`, [threadId]);

  res.status(201).json({ threadId, messages: await messagesFor(threadId) });
}

async function ownedThread(id: string, doctorId: string) {
  // A malformed id would otherwise reach Postgres as an invalid uuid.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const { rows } = await pool.query(
    `SELECT id, title FROM cliniq.ai_threads WHERE id = $1 AND doctor_id = $2`,
    [id, doctorId]
  );
  return rows[0];
}

async function messagesFor(threadId: string) {
  const { rows } = await pool.query(
    `SELECT id, role, content, model, created_at FROM cliniq.ai_messages
     WHERE thread_id = $1 ORDER BY created_at`,
    [threadId]
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role as "user" | "assistant",
    content: r.content,
    model: r.model ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

async function exceededDailyLimit(doctorId: string) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
     FROM cliniq.ai_messages m
     JOIN cliniq.ai_threads t ON t.id = m.thread_id
     WHERE t.doctor_id = $1 AND m.role = 'user' AND m.created_at > now() - interval '24 hours'`,
    [doctorId]
  );
  return rows[0].n >= DAILY_QUESTION_LIMIT;
}

const dailyLimitMessage = () =>
  `You've reached the limit of ${DAILY_QUESTION_LIMIT} questions in 24 hours.`;

function titleFrom(question: string) {
  const firstLine = question.split("\n")[0].trim();
  return firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine;
}

export default router;
