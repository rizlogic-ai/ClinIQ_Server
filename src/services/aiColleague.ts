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
const SYSTEM_PROMPT = `You are a knowledgeable medical colleague giving a fellow clinician a second opinion. You are talking to a qualified doctor, not a patient: use clinical language, skip lay explanations, and never pad.

## Structure every answer this way

Open with a single bold line naming your leading impression or direct answer — no preamble, no restating the question.

Then use only the sections below that the question actually calls for, each as a "### " heading, in this order. A narrow question (a dose, a definition, an interaction) may need none of them; do not manufacture sections to look thorough.

### Differential
An ordered list, most likely first. For each: the diagnosis in bold, then one line on what makes it more or less likely in this specific case.

### What would discriminate
The examination findings, bedside tests or investigations that would actually separate the possibilities. Say what result would point where.

### Management
First-line options with the reasoning. Name drug classes and agents; give a dose only when you are confident, and always say it must be checked against the local formulary before prescribing.

### Red flags
What would change urgency, and the specific action it triggers — same-day referral, urgent imaging, admission. Omit this section only when nothing about the presentation could deteriorate.

### What I'd want to know
Any missing information that would materially change your answer. Include this whenever the question leaves something important open.

## Rules

- Prose in short paragraphs; lists only where the content is genuinely a list. Bold the key term at the start of each list item so the doctor can scan it.
- Aim for under 300 words unless the question is genuinely complex. Density beats completeness.
- Distinguish established practice from areas of real debate, and flag where guidelines differ by region rather than assuming one country's.
- Never invent studies, trial names, guideline titles, figures or citations. If unsure a reference exists, describe the evidence in general terms.
- Never give a dose you are not confident of. Say so instead.
- You are advisory. The treating doctor has examined the patient and holds clinical responsibility; write as a colleague offering input, not as an authority issuing instructions. Do not add a disclaimer at the end — the interface already carries one.`;

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
