import { safeRouter } from "../utils/safeRouter";
import { z } from "zod";
import { patientHistoryRepository, patientProfileRepository, patientRepository } from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";
import { visiblePatientIds } from "../utils/scope";
import { dateField } from "../utils/datetime";

const router = safeRouter();
// Patient charts are staff-only. Patients reach their own data through
// /api/portal, never through these clinic-wide listings.
router.use(requireAuth, requireRole("doctor", "assistant"));

const createPatientSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

router.get("/", async (req, res) => {
  const [patients, allowed] = await Promise.all([
    patientRepository.list(),
    visiblePatientIds(req.user!),
  ]);
  res.json({ patients: patients.filter((p) => allowed.has(p.id)) });
});

router.post("/", requireRole("assistant"), async (req, res) => {
  const parsed = createPatientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { name, phone, email, notes } = parsed.data;
  const patient = await patientRepository.create({
    name,
    phone,
    email: email || undefined,
    notes,
  });
  res.status(201).json({ patient });
});

const createHistorySchema = z.object({
  title: z.string().min(1),
  notes: z.string().min(1),
  source: z.enum(["form", "scan"]).default("form"),
  attachmentDataUrl: z
    .string()
    .startsWith("data:image/")
    .max(8_000_000)
    .optional(),
});

// Doctor or assistant: log a patient history entry (typed, or transcribed from a scan)
router.post("/:id/history", async (req, res) => {
  const patient = await patientRepository.findById(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  if (!(await visiblePatientIds(req.user!)).has(patient.id)) {
    return res.status(404).json({ error: "Patient not found" });
  }

  const parsed = createHistorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const entry = await patientHistoryRepository.create({
    patientId: patient.id,
    authorId: req.user!.sub,
    title: parsed.data.title,
    notes: parsed.data.notes,
    source: parsed.data.source,
    attachmentDataUrl: parsed.data.attachmentDataUrl,
  });
  res.status(201).json({ entry });
});

router.get("/:id/history", async (req, res) => {
  const patient = await patientRepository.findById(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  if (!(await visiblePatientIds(req.user!)).has(patient.id)) {
    return res.status(404).json({ error: "Patient not found" });
  }
  const entries = await patientHistoryRepository.listByPatient(patient.id);
  res.json({ entries });
});

// ── Structured patient profile (standard intake) ──────────────
// Distinct from the free-text history above: fixed fields, not prose — the
// shape a future disease-risk model would train against.
// Every field is nullable as well as optional: a key that's absent means
// "leave this field as it is" (true PATCH semantics — see the handler
// below), while a key present with null means "clear it".
const profileSchema = z.object({
  dateOfBirth: dateField
    .nullable()
    .optional()
    .refine((v) => !v || new Date(v).getTime() <= Date.now(), "Date of birth can't be in the future"),
  gender: z.enum(["male", "female", "other"]).nullable().optional(),
  bloodGroup: z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"]).nullable().optional(),
  heightCm: z.number().min(30).max(250).nullable().optional(),
  weightKg: z.number().min(1).max(400).nullable().optional(),
  smoking: z.enum(["never", "former", "current"]).nullable().optional(),
  alcohol: z.enum(["never", "occasional", "regular"]).nullable().optional(),
  exercise: z.enum(["sedentary", "light", "active"]).nullable().optional(),
  chronicConditions: z.array(z.string().trim().min(1)).max(30).optional(),
  currentMedications: z.string().max(2000).nullable().optional(),
  allergies: z.string().max(2000).nullable().optional(),
  familyHistory: z.string().max(2000).nullable().optional(),
});

router.get("/:id/profile", async (req, res) => {
  const patient = await patientRepository.findById(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  if (!(await visiblePatientIds(req.user!)).has(patient.id)) {
    return res.status(404).json({ error: "Patient not found" });
  }
  const profile = await patientProfileRepository.findByPatient(patient.id);
  res.json({ profile: profile ?? null });
});

router.patch("/:id/profile", async (req, res) => {
  const patient = await patientRepository.findById(req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  if (!(await visiblePatientIds(req.user!)).has(patient.id)) {
    return res.status(404).json({ error: "Patient not found" });
  }
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // A genuinely partial PATCH: a field missing from the body keeps its
  // current value; a field present as null clears it. Without this, a
  // caller updating just one field (say, allergies) would wipe every other
  // field the form didn't happen to resend.
  const body = req.body as Record<string, unknown>;
  const existing = await patientProfileRepository.findByPatient(patient.id);
  const data = {
    dateOfBirth: "dateOfBirth" in body ? (parsed.data.dateOfBirth ?? undefined) : existing?.dateOfBirth,
    gender: "gender" in body ? (parsed.data.gender ?? undefined) : existing?.gender,
    bloodGroup: "bloodGroup" in body ? (parsed.data.bloodGroup ?? undefined) : existing?.bloodGroup,
    heightCm: "heightCm" in body ? (parsed.data.heightCm ?? undefined) : existing?.heightCm,
    weightKg: "weightKg" in body ? (parsed.data.weightKg ?? undefined) : existing?.weightKg,
    smoking: "smoking" in body ? (parsed.data.smoking ?? undefined) : existing?.smoking,
    alcohol: "alcohol" in body ? (parsed.data.alcohol ?? undefined) : existing?.alcohol,
    exercise: "exercise" in body ? (parsed.data.exercise ?? undefined) : existing?.exercise,
    chronicConditions: "chronicConditions" in body
      ? parsed.data.chronicConditions ?? []
      : existing?.chronicConditions ?? [],
    currentMedications: "currentMedications" in body ? (parsed.data.currentMedications ?? undefined) : existing?.currentMedications,
    allergies: "allergies" in body ? (parsed.data.allergies ?? undefined) : existing?.allergies,
    familyHistory: "familyHistory" in body ? (parsed.data.familyHistory ?? undefined) : existing?.familyHistory,
  };

  const profile = await patientProfileRepository.upsert(patient.id, req.user!.sub, data);
  res.json({ profile });
});

export default router;
