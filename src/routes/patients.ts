import { Router } from "express";
import { z } from "zod";
import { patientHistoryRepository, patientRepository } from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const createPatientSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});

router.get("/", async (_req, res) => {
  const patients = await patientRepository.list();
  res.json({ patients });
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
  const entries = await patientHistoryRepository.listByPatient(patient.id);
  res.json({ entries });
});

export default router;
