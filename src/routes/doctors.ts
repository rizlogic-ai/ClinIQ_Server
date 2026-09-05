import { safeRouter } from "../utils/safeRouter";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { doctorAssistantRepository, userRepository } from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";

const router = safeRouter();
router.use(requireAuth, requireRole("doctor", "assistant"));

// Assistant: list the doctors they're assigned to (for picking one when booking)
router.get("/", requireRole("assistant"), async (req, res) => {
  const doctors = await doctorAssistantRepository.listDoctorsForAssistant(req.user!.sub);
  res.json({
    doctors: doctors.map((d) => ({ id: d.id, name: d.name, username: d.username })),
  });
});

const createAssistantSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  name: z.string().min(1),
});

// Doctor: add an assistant of their own — created in the doctor's clinic and
// auto-assigned to that doctor.
router.post("/assistants", requireRole("doctor"), async (req, res) => {
  const parsed = createAssistantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (await userRepository.findByUsername(parsed.data.username)) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const doctor = await userRepository.findById(req.user!.sub);
  if (!doctor) return res.status(404).json({ error: "Doctor not found" });

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const assistant = await userRepository.create({
    username: parsed.data.username,
    passwordHash,
    name: parsed.data.name,
    role: "assistant",
    clinicId: doctor.clinicId,
  });
  await doctorAssistantRepository.assign(doctor.id, assistant.id);
  res
    .status(201)
    .json({ assistant: { id: assistant.id, username: assistant.username, name: assistant.name } });
});

export default router;
