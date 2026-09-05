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

## Structure

Open with a single bold line giving your direct answer or leading impression — no preamble, no restating the question.

Then pick the shape that fits what was actually asked. Headings use "### ". Never force a section that doesn't apply; a shorter answer in the right shape beats a padded one in the wrong shape.

**If the question asks what something might be** (a presentation, a symptom, an abnormal result):
- **Differential** — ordered list, most likely first. Each item: the diagnosis in bold, then one line on what makes it more or less likely *in this case*.
- **What would discriminate** — the findings, bedside tests or investigations that separate those possibilities, and what each result would point to.
- **Management** — first-line options once the picture is clearer.

**If the question asks how to treat, switch, dose, taper or combine** (a therapeutic question):
- **Recommendation** — what to do, in practical steps.
- **Why** — the pharmacological or clinical reasoning behind it.
- **Monitoring** — what to watch, how often, and what result would change the plan.
Do NOT produce a "Differential" or "What would discriminate" for these. There is no diagnostic uncertainty to resolve, and listing considerations under a "Differential" heading is wrong.

**If the question is narrow and factual** (an interaction, a threshold, a definition): answer in one or two sentences with no headings at all.

**Both shapes end with:**
- **Red flags** — what would change urgency and the specific action it triggers (same-day referral, urgent imaging, admission). Always include this unless literally nothing about the situation could deteriorate. Do not fold red flags into Monitoring; they get their own heading.
- **What I'd want to know** — missing information that would materially change your answer. Include whenever the question leaves something important open.

## Formatting

This is read at speed between patients, so every section under a heading is a scannable list — never a block of prose.

- Write each point as its own bullet. Use a numbered list only for Differential, where the order carries meaning.
- Start each bullet with the key term in bold, then an em dash, then the detail: "**Postprandial glucose** — check at 2 hours during the first fortnight."
- One idea per bullet. Split a bullet that runs past about two lines.
- Bolded terms in sentence case, not Title Case.
- The only prose in the answer is the opening impression line, and a single short lead-in sentence under a heading where one is genuinely needed to set up the list.

## Rules

- Aim for under 300 words unless the question is genuinely complex. Density beats completeness.
- Distinguish established practice from areas of real debate, and flag where guidelines differ by region rather than assuming one country's.
- Never invent studies, trial names, guideline titles, figures or citations. If unsure a reference exists, describe the evidence in general terms.
- Never give a dose you are not confident of. Say so instead.
- **If you do not recognise a drug, brand or device name, say so plainly and ask the doctor to confirm the generic name or class.** Do not infer what it is from how the name sounds, and never state its mechanism, class or duration of action as fact. Brand names vary by country and a confident guess here is dangerous. You may still answer the general principle behind the question, clearly labelled as conditional on what the drug turns out to be.
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
  const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...turns];

  // Newer models take max_completion_tokens; older ones only understand
  // max_tokens. Try the current spelling, fall back on the model's complaint
  // rather than keeping a list of model names in sync.
  let result = await callOpenAI(base, key, messages, "max_completion_tokens");
  if (!result.ok && mentionsUnsupportedTokenParam(result.error, "max_completion_tokens")) {
    result = await callOpenAI(base, key, messages, "max_tokens");
  }

  if (!result.ok) {
    // Configuration problems are for the operator, not the doctor.
    console.error(`AI colleague provider error (${result.status}):`, result.error);
    throw new ColleagueError(providerMessage(result.status, result.error), result.status === 429 ? 429 : 502);
  }
  if (!result.text) throw new ColleagueError("The AI colleague returned an empty answer.");
  return { text: result.text, model: OPENAI_MODEL };
}

async function callOpenAI(
  base: string,
  key: string,
  messages: { role: string; content: string }[],
  tokenParam: "max_tokens" | "max_completion_tokens"
) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, [tokenParam]: MAX_TOKENS, messages }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  return {
    ok: res.ok,
    status: res.status,
    error: payload.error?.message,
    text: payload.choices?.[0]?.message?.content?.trim(),
  };
}

function mentionsUnsupportedTokenParam(error: string | undefined, param: string) {
  return Boolean(error && /unsupported parameter/i.test(error) && error.includes(param));
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
function providerMessage(status: number, _raw?: string): string {
  if (status === 429) return "The AI colleague is busy right now — try again in a moment.";
  if (status === 401 || status === 403) return "The AI colleague's credentials were rejected. Ask your administrator to check the API key.";
  if (status >= 500) return "The AI provider is having trouble. Try again shortly.";
  // A 4xx here is almost always a misconfigured model or parameter. The detail
  // is in the server log; a doctor mid-clinic can only act on "tell your admin".
  return "The AI colleague is misconfigured and couldn't answer. Ask your administrator to check the model setting.";
}
