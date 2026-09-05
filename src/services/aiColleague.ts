export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ColleagueReply {
  text: string;
  model: string;
}

export class ColleagueError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * The AI colleague speaks to a clinician, not a patient. It is a sounding
 * board: it should reason out loud, surface what might be missed, and be
 * plain about uncertainty — never impersonate a definitive ruling.
 */
const SYSTEM_PROMPT = `You are a knowledgeable medical colleague giving a fellow clinician a quick second opinion. You are talking to a qualified doctor, not a patient, so use clinical language and skip lay explanations.

How to answer:
- Lead with the most useful thing. Doctors are busy; two or three tight paragraphs or a short list beats an essay.
- Give a differential when the question implies one, ordered by likelihood, and say what would discriminate between the possibilities.
- Name the red flags that would change urgency, and say plainly when something needs escalation, admission or urgent imaging.
- Where guidelines differ by region, say so rather than assuming one country's practice.

Be honest about limits:
- If the question is ambiguous or hinges on missing information, say what you would need to know instead of guessing.
- Distinguish well-established practice from areas of genuine debate.
- Never invent studies, guideline names, figures or citations. If you are not certain a reference exists, describe the evidence in general terms instead.
- For drug doses, state that the figure must be checked against a current local formulary before prescribing, and never give a dose you are unsure of.

You are advisory. The treating doctor has examined the patient and holds clinical responsibility for the decision; write as a colleague offering input, not as an authority issuing instructions.`;

const PROVIDER = (process.env.AI_PROVIDER || "openai").toLowerCase();
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 1200;

export function isColleagueConfigured(): boolean {
  return PROVIDER === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY);
}

export async function askColleague(turns: ChatTurn[]): Promise<ColleagueReply> {
  if (PROVIDER === "anthropic") return askAnthropic(turns);
  return askOpenAI(turns);
}

async function askOpenAI(turns: ChatTurn[]): Promise<ColleagueReply> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new ColleagueError("The AI colleague is not configured yet.", 503);
  }

  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...turns],
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new ColleagueError(providerMessage(res.status, payload.error?.message), res.status === 429 ? 429 : 502);
  }
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ColleagueError("The AI colleague returned an empty answer.");
  return { text, model: OPENAI_MODEL };
}

// Reserved for the advanced subscription tier; unused until ANTHROPIC_API_KEY
// and AI_PROVIDER=anthropic are set.
async function askAnthropic(turns: ChatTurn[]): Promise<ColleagueReply> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new ColleagueError("The AI colleague is not configured yet.", 503);
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: turns,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    content?: { text?: string }[];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new ColleagueError(providerMessage(res.status, payload.error?.message), res.status === 429 ? 429 : 502);
  }
  const text = payload.content?.map((c) => c.text ?? "").join("").trim();
  if (!text) throw new ColleagueError("The AI colleague returned an empty answer.");
  return { text, model: CLAUDE_MODEL };
}

// The provider's own wording can leak keys or billing detail, so map to
// something a doctor can act on.
function providerMessage(status: number, raw?: string): string {
  if (status === 429) return "The AI colleague is busy right now — try again in a moment.";
  if (status === 401 || status === 403) return "The AI colleague's credentials were rejected. Ask your administrator to check the API key.";
  if (status >= 500) return "The AI provider is having trouble. Try again shortly.";
  return raw ? `The AI colleague could not answer: ${raw}` : "The AI colleague could not answer that.";
}
