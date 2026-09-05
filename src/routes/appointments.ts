import { safeRouter } from "../utils/safeRouter";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import {
  appointmentRepository,
  doctorAssistantRepository,
  patientRepository,
  userRepository,
} from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";
import { dateField, timeField } from "../utils/datetime";
import { Appointment, AppointmentHistoryEntry } from "../models/types";
import {
  appointmentCancelledToPatient,
  appointmentConfirmedToPatient,
  appointmentRequestedToPatient,
  appointmentRescheduledToPatient,
} from "../services/notifications";

const router = safeRouter();
router.use(requireAuth);

function historyEntry(actorId: string, action: string, detail?: string): AppointmentHistoryEntry {
  return { timestamp: new Date().toISOString(), actorId, action, detail };
}

const createAppointmentSchema = z.object({
  doctorId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
  newPatient: z
    .object({
      name: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().email().optional().or(z.literal("")),
    })
    .optional(),
  reason: z.string().min(1),
  date: dateField,
  time: timeField,
});

router.get("/", async (req, res) => {
  const [appointments, patients, doctors] = await Promise.all([
    appointmentRepository.list(),
    patientRepository.list(),
    userRepository.list(),
  ]);

  // Default-deny: only roles with an explicit rule below see anything. A
  // patient's own appointments come from /api/portal/appointments instead.
  let visible: typeof appointments = [];
  if (req.user!.role === "doctor") {
    visible = appointments.filter((a) => a.doctorId === req.user!.sub);
  } else if (req.user!.role === "assistant") {
    const assignedDoctorIds = new Set(
      (await doctorAssistantRepository.listDoctorsForAssistant(req.user!.sub)).map((d) => d.id)
    );
    visible = appointments.filter((a) => assignedDoctorIds.has(a.doctorId));
  }

  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const doctorMap = new Map(doctors.map((d) => [d.id, d]));
  const enriched = visible.map((a) => ({
    ...a,
    patient: patientMap.get(a.patientId) || null,
    doctor: (() => {
      const d = doctorMap.get(a.doctorId);
      return d ? { id: d.id, name: d.name, username: d.username } : null;
    })(),
  }));
  res.json({ appointments: enriched });
});

// Assistant: create appointment (either for an existing patient or a new one)
router.post("/", requireRole("assistant"), async (req, res) => {
  const parsed = createAppointmentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { doctorId, patientId, newPatient, reason, date, time } = parsed.data;

  const doctor = await userRepository.findById(doctorId);
  if (!doctor || doctor.role !== "doctor") {
    return res.status(404).json({ error: "Doctor not found" });
  }
  if (!doctor.isActive) {
    return res.status(400).json({ error: "This doctor is no longer active" });
  }
  const assigned = await doctorAssistantRepository.isAssigned(doctorId, req.user!.sub);
  if (!assigned) {
    return res.status(403).json({ error: "You are not assigned to this doctor" });
  }

  if (!patientId && !newPatient) {
    return res.status(400).json({ error: "Provide patientId or newPatient" });
  }

  let resolvedPatientId = patientId;
  if (!resolvedPatientId && newPatient) {
    const created = await patientRepository.create({
      name: newPatient.name,
      phone: newPatient.phone,
      email: newPatient.email || undefined,
    });
    resolvedPatientId = created.id;
  } else if (resolvedPatientId) {
    const existing = await patientRepository.findById(resolvedPatientId);
    if (!existing) {
      return res.status(404).json({ error: "Patient not found" });
    }
  }

  const now = new Date().toISOString();
  const appointment: Appointment = {
    id: uuid(),
    patientId: resolvedPatientId!,
    doctorId,
    reason,
    date,
    time,
    status: "pending",
    createdBy: req.user!.sub,
    createdAt: now,
    updatedAt: now,
    services: [],
    history: [historyEntry(req.user!.sub, "created", `Requested for ${date} ${time}`)],
  };

  await appointmentRepository.create(appointment);
  await appointmentRequestedToPatient(appointment.id);
  res.status(201).json({ appointment });
});

// Doctor: accept a pending appointment
router.patch("/:id/accept", requireRole("doctor"), async (req, res) => {
  let failed = false;
  const updated = await appointmentRepository.update(req.params.id, (appt) => {
    if (appt.status !== "pending") {
      failed = true;
      return appt;
    }
    return {
      ...appt,
      status: "accepted",
      updatedAt: new Date().toISOString(),
      history: [...appt.history, historyEntry(req.user!.sub, "accepted")],
    };
  });
  if (!updated) return res.status(404).json({ error: "Appointment not found" });
  if (failed) return res.status(409).json({ error: "Only pending appointments can be accepted" });
  await appointmentConfirmedToPatient(updated.id);
  res.json({ appointment: updated });
});

const rejectSchema = z.object({ reason: z.string().min(1) });

// Doctor: reject a pending appointment
router.patch("/:id/reject", requireRole("doctor"), async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "reason is required" });
  }
  let failed = false;
  const updated = await appointmentRepository.update(req.params.id, (appt) => {
    if (appt.status !== "pending") {
      failed = true;
      return appt;
    }
    return {
      ...appt,
      status: "rejected",
      rejectionReason: parsed.data.reason,
      updatedAt: new Date().toISOString(),
      history: [...appt.history, historyEntry(req.user!.sub, "rejected", parsed.data.reason)],
    };
  });
  if (!updated) return res.status(404).json({ error: "Appointment not found" });
  if (failed) return res.status(409).json({ error: "Only pending appointments can be rejected" });
  await appointmentCancelledToPatient(updated.id, parsed.data.reason);
  res.json({ appointment: updated });
});

const rescheduleSchema = z.object({
  date: dateField,
  time: timeField,
  note: z.string().optional(),
});

// Doctor: modify (reschedule) an appointment
router.patch("/:id/reschedule", requireRole("doctor"), async (req, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let failed = false;
  const updated = await appointmentRepository.update(req.params.id, (appt) => {
    if (appt.status === "completed" || appt.status === "cancelled" || appt.status === "rejected") {
      failed = true;
      return appt;
    }
    return {
      ...appt,
      date: parsed.data.date,
      time: parsed.data.time,
      doctorNote: parsed.data.note ?? appt.doctorNote,
      updatedAt: new Date().toISOString(),
      history: [
        ...appt.history,
        historyEntry(req.user!.sub, "rescheduled", `${parsed.data.date} ${parsed.data.time}`),
      ],
    };
  });
  if (!updated) return res.status(404).json({ error: "Appointment not found" });
  if (failed) return res.status(409).json({ error: "This appointment can no longer be modified" });
  await appointmentRescheduledToPatient(updated.id);
  res.json({ appointment: updated });
});

const completeSchema = z.object({
  services: z
    .array(
      z.object({
        description: z.string().min(1),
        amount: z.number().nonnegative(),
      })
    )
    .min(1),
});

// Doctor: mark appointment completed and record fee/services rendered
router.patch("/:id/complete", requireRole("doctor"), async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let failed = false;
  const updated = await appointmentRepository.update(req.params.id, (appt) => {
    if (appt.status !== "accepted") {
      failed = true;
      return appt;
    }
    const total = parsed.data.services.reduce((sum, s) => sum + s.amount, 0);
    return {
      ...appt,
      status: "completed",
      services: parsed.data.services.map((s) => ({ id: uuid(), ...s })),
      updatedAt: new Date().toISOString(),
      history: [
        ...appt.history,
        historyEntry(req.user!.sub, "completed", `Fee total: ${total}`),
      ],
    };
  });
  if (!updated) return res.status(404).json({ error: "Appointment not found" });
  if (failed) return res.status(409).json({ error: "Only accepted appointments can be completed" });
  res.json({ appointment: updated });
});

// Assistant: cancel an appointment that hasn't happened yet
router.patch("/:id/cancel", requireRole("assistant"), async (req, res) => {
  let failed = false;
  const updated = await appointmentRepository.update(req.params.id, (appt) => {
    if (appt.status === "completed" || appt.status === "cancelled") {
      failed = true;
      return appt;
    }
    return {
      ...appt,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
      history: [...appt.history, historyEntry(req.user!.sub, "cancelled")],
    };
  });
  if (!updated) return res.status(404).json({ error: "Appointment not found" });
  if (failed) return res.status(409).json({ error: "This appointment can no longer be cancelled" });
  await appointmentCancelledToPatient(updated.id);
  res.json({ appointment: updated });
});

export default router;
