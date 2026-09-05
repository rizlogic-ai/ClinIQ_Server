import { safeRouter } from "../utils/safeRouter";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  adminRepository,
  clinicRepository,
  doctorAssistantRepository,
  subscriptionRepository,
  userRepository,
} from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";
import { signToken } from "../utils/jwt";

const router = safeRouter();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "username and password are required" });
  }
  const admin = await adminRepository.findByUsername(parsed.data.username);
  if (!admin) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const valid = await bcrypt.compare(parsed.data.password, admin.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = signToken({ sub: admin.id, role: "admin", name: admin.name, username: admin.username });
  res.json({ token, admin: { id: admin.id, name: admin.name, username: admin.username } });
});

router.use(requireAuth, requireRole("admin"));

function isForeignKeyViolation(err: unknown) {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23503";
}

// 1st doctor billed at tier1Price, 2nd at tier2Price, every doctor after
// that at the flat tier3PlusPrice.
function computeMonthlyTotal(
  doctorCount: number,
  tiers: { tier1Price: number; tier2Price: number; tier3PlusPrice: number }
) {
  let total = 0;
  if (doctorCount >= 1) total += tiers.tier1Price;
  if (doctorCount >= 2) total += tiers.tier2Price;
  if (doctorCount > 2) total += tiers.tier3PlusPrice * (doctorCount - 2);
  return total;
}

async function clinicSummary(clinic: {
  id: string;
  name: string;
  country?: string;
  city?: string;
  currency: string;
  isActive: boolean;
  createdAt: string;
}) {
  const [doctorCount, subscription] = await Promise.all([
    clinicRepository.countDoctors(clinic.id),
    subscriptionRepository.findByClinicId(clinic.id),
  ]);
  return {
    id: clinic.id,
    name: clinic.name,
    country: clinic.country ?? null,
    city: clinic.city ?? null,
    currency: clinic.currency,
    isActive: clinic.isActive,
    createdAt: clinic.createdAt,
    doctorCount,
    subscription: subscription
      ? {
          tier1Price: subscription.tier1Price,
          tier2Price: subscription.tier2Price,
          tier3PlusPrice: subscription.tier3PlusPrice,
          status: subscription.status,
          monthlyTotal: computeMonthlyTotal(doctorCount, subscription),
        }
      : null,
  };
}

const createClinicSchema = z.object({
  name: z.string().min(1),
  country: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  currency: z.string().min(1).default("USD"),
  tier1Price: z.number().nonnegative(),
  tier2Price: z.number().nonnegative(),
  tier3PlusPrice: z.number().nonnegative(),
});

router.post("/clinics", async (req, res) => {
  const parsed = createClinicSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const clinic = await clinicRepository.create({
    name: parsed.data.name,
    country: parsed.data.country,
    city: parsed.data.city,
    currency: parsed.data.currency,
  });
  await subscriptionRepository.create(clinic.id, {
    tier1Price: parsed.data.tier1Price,
    tier2Price: parsed.data.tier2Price,
    tier3PlusPrice: parsed.data.tier3PlusPrice,
  });
  res.status(201).json({ clinic: await clinicSummary(clinic) });
});

router.get("/clinics", async (_req, res) => {
  const clinics = await clinicRepository.list();
  const summaries = await Promise.all(clinics.map((c) => clinicSummary(c)));
  res.json({ clinics: summaries });
});

const updateClinicSchema = z.object({
  name: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

router.patch("/clinics/:clinicId", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });
  const parsed = updateClinicSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const updated = await clinicRepository.update(clinic.id, parsed.data);
  res.json({ clinic: await clinicSummary(updated!) });
});

router.delete("/clinics/:clinicId", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });
  try {
    await clinicRepository.delete(clinic.id);
    res.json({ deleted: true });
  } catch (err) {
    if (!isForeignKeyViolation(err)) {
      console.error(err);
      return res.status(500).json({ error: "Failed to delete clinic" });
    }
    const deactivated = await clinicRepository.update(clinic.id, { isActive: false });
    res.json({ deleted: false, deactivated: true, clinic: await clinicSummary(deactivated!) });
  }
});

const subscriptionSchema = z.object({
  tier1Price: z.number().nonnegative().optional(),
  tier2Price: z.number().nonnegative().optional(),
  tier3PlusPrice: z.number().nonnegative().optional(),
  status: z.enum(["active", "paused", "cancelled"]).optional(),
});

router.get("/clinics/:clinicId/subscription", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });
  res.json({ clinic: await clinicSummary(clinic) });
});

router.patch("/clinics/:clinicId/subscription", async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const updated = await subscriptionRepository.update(req.params.clinicId, parsed.data);
  if (!updated) return res.status(404).json({ error: "Subscription not found" });
  const clinic = await clinicRepository.findById(req.params.clinicId);
  res.json({ clinic: await clinicSummary(clinic!) });
});

router.get("/clinics/:clinicId/staff", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });

  const [doctors, assistants] = await Promise.all([
    userRepository.listByClinic(clinic.id, "doctor"),
    userRepository.listByClinic(clinic.id, "assistant"),
  ]);

  const assistantsWithDoctors = await Promise.all(
    assistants.map(async (a) => ({
      id: a.id,
      username: a.username,
      name: a.name,
      isActive: a.isActive,
      doctors: (await doctorAssistantRepository.listDoctorsForAssistant(a.id)).map((d) => ({
        id: d.id,
        username: d.username,
        name: d.name,
        isActive: d.isActive,
      })),
    }))
  );

  res.json({
    doctors: doctors.map((d) => ({ id: d.id, username: d.username, name: d.name, isActive: d.isActive })),
    assistants: assistantsWithDoctors,
  });
});

const createStaffSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  name: z.string().min(1),
});

router.post("/clinics/:clinicId/doctors", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });
  const parsed = createStaffSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (await userRepository.findByUsername(parsed.data.username)) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const doctor = await userRepository.create({
    username: parsed.data.username,
    passwordHash,
    name: parsed.data.name,
    role: "doctor",
    clinicId: clinic.id,
  });
  res.status(201).json({
    doctor: { id: doctor.id, username: doctor.username, name: doctor.name, isActive: doctor.isActive },
  });
});

const createAssistantSchema = createStaffSchema.extend({
  doctorIds: z.array(z.string().uuid()).optional(),
});

router.post("/clinics/:clinicId/assistants", async (req, res) => {
  const clinic = await clinicRepository.findById(req.params.clinicId);
  if (!clinic) return res.status(404).json({ error: "Clinic not found" });
  const parsed = createAssistantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (await userRepository.findByUsername(parsed.data.username)) {
    return res.status(409).json({ error: "Username already taken" });
  }

  const doctorIds = parsed.data.doctorIds ?? [];
  const doctorsInClinic = await userRepository.listByClinic(clinic.id, "doctor");
  const doctorsInClinicIds = new Set(doctorsInClinic.map((d) => d.id));
  const invalid = doctorIds.filter((id) => !doctorsInClinicIds.has(id));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Doctor(s) not found in this clinic: ${invalid.join(", ")}` });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const assistant = await userRepository.create({
    username: parsed.data.username,
    passwordHash,
    name: parsed.data.name,
    role: "assistant",
    clinicId: clinic.id,
  });
  for (const doctorId of doctorIds) {
    await doctorAssistantRepository.assign(doctorId, assistant.id);
  }
  res.status(201).json({
    assistant: {
      id: assistant.id,
      username: assistant.username,
      name: assistant.name,
      isActive: assistant.isActive,
    },
  });
});

const updateStaffSchema = z.object({
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(6).optional(),
  isActive: z.boolean().optional(),
});

function staffView(staff: { id: string; username: string; name: string; role: string; isActive: boolean }) {
  return { id: staff.id, username: staff.username, name: staff.name, role: staff.role, isActive: staff.isActive };
}

// Edit a doctor's or assistant's name/username/password/active status.
router.patch("/staff/:id", async (req, res) => {
  const staff = await userRepository.findById(req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });

  const parsed = updateStaffSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  if (parsed.data.username && parsed.data.username.toLowerCase() !== staff.username.toLowerCase()) {
    const existing = await userRepository.findByUsername(parsed.data.username);
    if (existing) return res.status(409).json({ error: "Username already taken" });
  }

  const passwordHash = parsed.data.password
    ? await bcrypt.hash(parsed.data.password, 10)
    : undefined;

  const updated = await userRepository.update(staff.id, {
    name: parsed.data.name,
    username: parsed.data.username,
    passwordHash,
    isActive: parsed.data.isActive,
  });

  res.json({ staff: staffView(updated!) });
});

// Delete a doctor or assistant; if they have appointment/invoice/history
// records, deactivate them instead of destroying that data.
router.delete("/staff/:id", async (req, res) => {
  const staff = await userRepository.findById(req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found" });
  try {
    await userRepository.delete(staff.id);
    res.json({ deleted: true });
  } catch (err) {
    if (!isForeignKeyViolation(err)) {
      console.error(err);
      return res.status(500).json({ error: "Failed to delete staff member" });
    }
    const deactivated = await userRepository.update(staff.id, { isActive: false });
    res.json({ deleted: false, deactivated: true, staff: staffView(deactivated!) });
  }
});

const updateAssistantDoctorsSchema = z.object({
  doctorIds: z.array(z.string().uuid()),
});

// Replace which doctors an assistant works for.
router.patch("/staff/:id/doctors", async (req, res) => {
  const assistant = await userRepository.findById(req.params.id);
  if (!assistant || assistant.role !== "assistant") {
    return res.status(404).json({ error: "Assistant not found" });
  }

  const parsed = updateAssistantDoctorsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const doctorsInClinic = await userRepository.listByClinic(assistant.clinicId, "doctor");
  const validIds = new Set(doctorsInClinic.map((d) => d.id));
  const invalid = parsed.data.doctorIds.filter((id) => !validIds.has(id));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Doctor(s) not found in this clinic: ${invalid.join(", ")}` });
  }

  const current = await doctorAssistantRepository.listDoctorsForAssistant(assistant.id);
  const currentIds = new Set(current.map((d) => d.id));
  const nextIds = new Set(parsed.data.doctorIds);

  for (const id of nextIds) {
    if (!currentIds.has(id)) await doctorAssistantRepository.assign(id, assistant.id);
  }
  for (const id of currentIds) {
    if (!nextIds.has(id)) await doctorAssistantRepository.unassign(id, assistant.id);
  }

  const doctors = await doctorAssistantRepository.listDoctorsForAssistant(assistant.id);
  res.json({ doctors: doctors.map((d) => ({ id: d.id, username: d.username, name: d.name })) });
});

export default router;
