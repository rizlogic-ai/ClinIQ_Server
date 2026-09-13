# ClinIQ Server

Express + TypeScript + PostgreSQL backend for **ClinIQ**, a multi-tenant
clinic/appointment management SaaS. This is the system of record — the web
app (`ClinIQ_Web`) and mobile app (`ClinIQ_Mobile`) are both clients of this
API.

Live at: **https://cliniq-server-9e7d.onrender.com/api**
Health check: `GET /api/health`

## Related repos

| Repo | What it is |
|---|---|
| [ClinIQ_Web](https://github.com/rizlogic-ai/ClinIQ_Web) | React web app — staff, admin, and patient portal. Live at `cliniq.rizlogic.com`. |
| [ClinIQ_Mobile](https://github.com/rizlogic-ai/ClinIQ_Mobile) | Flutter app, doctors only. |

All three repos live side by side inside one local `Doctor-app/` folder
(`server/`, `client/`, `mobile/`) on the maintainer's machine, but that
parent folder is **not itself a git repo** — each subfolder is an
independent repo with its own GitHub remote. `cd` into the right one
before running `git` commands.

## Architecture

- **Database**: a dedicated `cliniq` Postgres schema on a shared instance
  (`careeriq_db`) — isolated from an unrelated pre-existing app on the same
  database. Never touch tables outside the `cliniq` schema.
- **Repository pattern**: `src/data/repositories.ts` defines interfaces,
  `src/data/postgresStore.ts` implements them against Postgres. An earlier
  in-memory implementation was fully removed once Postgres was in place —
  there is only one backing store now.
- **Auth**: JWT. Three separate login flows, three separate token shapes:
  - Staff (`doctor` / `assistant`) — `POST /api/auth/login`, `cliniq.users` table.
  - Admin — `POST /api/admin/login`, separate `cliniq.admins` table.
  - Patient — `POST /api/portal/request-otp` + `verify-otp`, phone-based, no password.
- **Multi-tenancy**: every clinic's data must stay isolated from every other
  clinic's. Visibility is derived, not stored — see `src/utils/scope.ts`:
  a doctor sees their own records, an assistant sees the doctors they're
  assigned to, and patients/invoices are visible only through an appointment
  with a doctor the caller can see. **Any new patient-adjacent route must
  filter through `visibleDoctorIds`/`visiblePatientIds`** — this has already
  been the site of one real data-leak bug (patients and invoices were once
  returned unfiltered; see `git log --oneline -- src/utils/scope.ts`).

## Roles

| Role | Access |
|---|---|
| `doctor` | Their own appointments, patients, invoices, AI colleague, patient profiles |
| `assistant` | Appointments/patients/invoices for the doctors they're assigned to |
| `admin` | Platform administration — clinics, subscriptions, staff lifecycle |
| `patient` | Their own appointments only, via `/api/portal` |

A doctor can have many assistants and vice versa (`cliniq.doctor_assistants`
join table), enforced at both the API layer and a Postgres trigger.

## Local setup

```bash
npm install                 # postinstall also runs the build
cp .env.example .env        # then fill in DATABASE_URL at minimum
npm run dev                 # tsx watch, http://localhost:4000
```

Required: `DATABASE_URL` (external Postgres connection string — the
internal Render hostname only resolves from inside Render's network, so use
the *external* connection string for local dev), `JWT_SECRET`.

Optional (features degrade gracefully without them — see `.env.example`
for the full list and current model/limits):
- **Twilio** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`) —
  without these, WhatsApp notifications are composed and logged
  (`cliniq.messages` table) but never sent. OTP codes fall back to being
  echoed in the API response (`devCode`) when `NODE_ENV !== "production"`.
- **AI provider** (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` + `AI_PROVIDER`) —
  without a key, the AI colleague reports itself as unconfigured rather
  than failing on use.

## Database migrations

Run in order, once each, against the live database — there is no migration
runner, just numbered SQL files in `src/db/migrations/`. Applied via a
throwaway Node script (connect with `pg`, read the file, run it in a
transaction) — never left as a committed one-off script.

| # | What it added |
|---|---|
| 001 | Initial schema: users, patients, appointments, invoices + services/history sub-tables |
| 002 | Admin module: `cliniq.admins`, clinics, subscriptions |
| 003 | Clinic locale: country, city, currency |
| 004 | `patient_history` (free-text notes, typed or OCR-scanned) |
| 005 | Lifecycle (`is_active` on clinics/users) + tiered per-doctor pricing |
| 006 | Patient self-service portal: verified phone on patients, OTP table, `messages` log, appointments bookable without an assistant |
| 007 | AI colleague: `ai_threads`, `ai_messages` |
| 008 | Structured patient profile (`patient_profiles`) — see below |

**All 8 are already applied to the production database.** If you're
restoring from a backup or spinning up a fresh database, run them in
order 001→008.

## Feature map

### Appointments & billing (core)
Assistant books → doctor accepts/rejects/reschedules → doctor completes with
itemized services → assistant issues an invoice → mark paid. Full audit
trail on every appointment (`history` array). Currency is per-clinic, not
hardcoded — every amount is formatted via the clinic's `currency` field.

### Admin
Clinic CRUD with country/city/currency, tiered per-doctor subscription
pricing (`tier1Price` = 1st doctor, `tier2Price` = 2nd, `tier3PlusPrice` =
flat rate for every doctor beyond that — see `computeMonthlyTotal` in
`routes/admin.ts`), staff CRUD. Deleting a clinic or staff member with
existing records **deactivates instead of deleting** (`isForeignKeyViolation`
catches the FK constraint and falls back) — data is never silently lost.

### Patient self-service portal (`/api/portal`)
- **OTP sign-in**: phone → 6-digit code (hashed, single-use, 10-min expiry,
  60s resend cooldown, 5-attempt cap) → JWT. First-time numbers are asked
  for a name before an account is created.
- **Self-booking**: a signed-in patient books their own appointment
  (`booked_by_patient = true`, no assistant on the row).
- **Guest booking** (`POST /api/portal/guest-appointments`, no auth): a
  stopgap until Twilio is configured — write-only, never returns a token
  (a token would hand out access to whoever's phone number was typed in).
  Capped at 3 requests per number per 24h. Guest-created patients have
  `phone_verified = false`; the client shows an "Unverified number" badge
  on these so staff know to confirm before treating the slot as real.

### WhatsApp notifications (`src/services/notifications.ts` + `messaging.ts`)
Sent on: appointment requested, confirmed (doctor accepts), rescheduled,
cancelled/rejected. Every attempt is logged to `cliniq.messages`
(`status`: `sent` / `failed` / `skipped`) — OTP message bodies are redacted
in the log. A missing Twilio config never blocks the underlying action
(booking, accepting, etc.) — it just logs `skipped`.

### AI Colleague (`/api/ai-colleague`, doctor-only)
A doctor types a clinical question, gets a structured second opinion.
**Deliberately no patient data leaves the server** — only what the doctor
types is sent to the model provider. Threads are private per doctor,
persisted (`ai_threads`/`ai_messages`), capped at `AI_DAILY_LIMIT` questions
per doctor per 24h.

- **Provider**: OpenAI today (`AI_PROVIDER=openai`, default), with an
  Anthropic adapter already written and dormant (`AI_PROVIDER=anthropic` +
  `ANTHROPIC_API_KEY`) — the intended path for an advanced subscription
  tier later.
- **Model**: set via `OPENAI_MODEL`. Currently configured for
  `gpt-5.6-luna` (an extended-reasoning, cost-tier model — see commit
  `f91969b` for why the adapter had to support both `max_tokens` and
  `max_completion_tokens`, since newer models reject the older parameter).
- **The system prompt** (`src/services/aiColleague.ts`) is the thing most
  worth re-reading and tuning as real doctors use this. It currently
  enforces: a bold leading-impression line; one of three answer shapes
  chosen by question type (diagnostic / therapeutic / narrow-factual —
  don't force a "Differential" onto a dosing question); every section as
  bulleted, scannable lists, never prose paragraphs; explicit refusal to
  guess an unrecognized drug/brand name rather than inventing its
  mechanism; a formulary-check reminder on any dose; no invented
  citations; defers clinical responsibility to the treating doctor.

### Structured patient profile (`/api/patients/:id/profile`)
"Standard intake" data — demographics, vitals (BMI computed client-side,
never stored), lifestyle, chronic conditions, medications, allergies,
family history — kept separate from the free-text `patient_history` log
because it's fixed-shape data intended as future disease-prediction model
input, not clinical narrative. One profile per patient (upserted, not
versioned). **The PATCH endpoint has true partial-update semantics**: a
field absent from the request body keeps its stored value; a field present
as `null` clears it explicitly. This was a real bug once (see commit
`4cff1af`) — a naive "validate then upsert whatever zod returns" approach
silently nulled every field the caller didn't happen to resend.

## Safety nets worth knowing about

- **`src/utils/safeRouter.ts`**: wraps every route handler so an async
  rejection reaches Express's error middleware instead of becoming an
  unhandled rejection. Without this, one bad request used to be able to
  **crash the entire process** (a `time: "99:99"` value satisfied a
  regex, reached Postgres, threw, and took the server down — reachable
  unauthenticated via the guest booking endpoint). See commit `6473607`.
- **`src/utils/datetime.ts`** (`dateField`, `timeField`): validate real
  calendar dates and clock times, not just shape — `2026-02-31` and
  `25:00` are rejected with a 400 rather than reaching Postgres.
- **Global error handler + `process.on('unhandledRejection'/'uncaughtException')`**
  in `src/index.ts`: last line of defense: log and answer 500, never exit.

## Testing

`scripts/tests/e2e.mjs` — a self-contained end-to-end suite (~110 cases)
that runs directly against a live server (defaults to the production URL)
and a live database (`DATABASE_URL` from `.env`). It authenticates as every
role, exercises the full feature set in dependency order, asserts on
responses, and **deletes everything it created** before exiting — safe to
run against production.

```bash
node scripts/tests/e2e.mjs                              # against production
E2E_API=http://localhost:4000/api node scripts/tests/e2e.mjs   # against local
```

Covers: auth (all 4 roles), clinic/staff CRUD, tiered billing math,
lifecycle deactivation, assistant/doctor appointment workflows, invoicing,
patient history, OTP sign-in, patient self-booking, guest booking, role
isolation (a patient token must never see staff data; one clinic must
never see another's), WhatsApp message logging, currency correctness,
input validation (including the exact malformed inputs that once crashed
the process), and admin deletion safeguards.

**Run this after any change touching auth, scoping, or the appointment
lifecycle** — that's where the real bugs have been, twice.

## Deployment (Render)

Free tier, so no custom Build Command is available. `package.json` has a
`"postinstall": "npm run build"` script instead — runs automatically on
`npm install`, which Render always does. `"start": "node dist/index.js"`.

Env vars are set in the Render dashboard (Environment tab), not in a
committed file. At minimum: `DATABASE_URL`, `JWT_SECRET`. See
`.env.example` for the full optional list (Twilio, AI provider).

The free tier sleeps when idle — first request after a period of
inactivity can take up to ~50s. Warm it before a demo.

## Known gaps / things to revisit

- **Patient profile has no field-level audit trail** — just one
  `updated_by`/`updated_at` on the whole record. Fine today; if this
  becomes real training input for disease prediction, you'll want change
  history before trusting it as ground truth.
- **Guest booking has no real spam defense** beyond a per-number daily cap
  — someone can book under any name/number. Retire it once Twilio OTP
  sign-in is fully in place, or keep it deliberately as a low-friction
  fallback — that's a product call, not an engineering one.
- **SMS/WhatsApp reminders (pre-visit), a richer patient booking portal,
  and post-visit feedback/rating** were discussed and explicitly deferred
  by the user in favor of the design refresh and AI colleague work — not
  started.
- **Mobile app is doctor-only** — no assistant/admin/patient flows, no
  patient-history scanning UI (web-only, uses `tesseract.js` in-browser).
