import { safeRouter } from "../utils/safeRouter";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import {
  appointmentRepository,
  invoiceRepository,
  patientRepository,
  userRepository,
} from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";
import { Invoice } from "../models/types";

const router = safeRouter();
router.use(requireAuth, requireRole("doctor", "assistant"));

router.get("/", async (_req, res) => {
  const [invoices, patients, appointments, users] = await Promise.all([
    invoiceRepository.list(),
    patientRepository.list(),
    appointmentRepository.list(),
    userRepository.list(),
  ]);
  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const appointmentMap = new Map(appointments.map((a) => [a.id, a]));
  const userMap = new Map(users.map((u) => [u.id, u]));

  const enriched = invoices.map((i) => {
    const appointment = appointmentMap.get(i.appointmentId);
    const doctor = appointment ? userMap.get(appointment.doctorId) : undefined;
    const issuedByUser = userMap.get(i.issuedBy);
    return {
      ...i,
      patient: patientMap.get(i.patientId) || null,
      doctor: doctor ? { id: doctor.id, name: doctor.name, username: doctor.username } : null,
      appointmentDate: appointment?.date ?? null,
      appointmentReason: appointment?.reason ?? null,
      issuedByName: issuedByUser?.name ?? null,
    };
  });
  res.json({ invoices: enriched });
});

const createInvoiceSchema = z.object({
  appointmentId: z.string().uuid(),
});

// Assistant: issue an invoice for a completed appointment, using the
// services/fees the doctor recorded when completing it.
router.post("/", requireRole("assistant"), async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "appointmentId is required" });
  }
  const appointment = await appointmentRepository.findById(parsed.data.appointmentId);
  if (!appointment) {
    return res.status(404).json({ error: "Appointment not found" });
  }
  if (appointment.status !== "completed") {
    return res.status(409).json({ error: "Appointment must be completed before invoicing" });
  }
  const existing = await invoiceRepository.findByAppointmentId(appointment.id);
  if (existing) {
    return res.status(409).json({ error: "Invoice already issued for this appointment", invoice: existing });
  }

  const total = appointment.services.reduce((sum, s) => sum + s.amount, 0);
  const invoice: Invoice = {
    id: uuid(),
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    services: appointment.services,
    total,
    status: "unpaid",
    issuedBy: req.user!.sub,
    issuedAt: new Date().toISOString(),
  };
  await invoiceRepository.create(invoice);
  res.status(201).json({ invoice });
});

// Assistant: mark an invoice as paid
router.patch("/:id/pay", requireRole("assistant"), async (req, res) => {
  let failed = false;
  const updated = await invoiceRepository.update(req.params.id, (inv) => {
    if (inv.status !== "unpaid") {
      failed = true;
      return inv;
    }
    return { ...inv, status: "paid", paidAt: new Date().toISOString() };
  });
  if (!updated) return res.status(404).json({ error: "Invoice not found" });
  if (failed) return res.status(409).json({ error: "Only unpaid invoices can be marked paid" });
  res.json({ invoice: updated });
});

export default router;
