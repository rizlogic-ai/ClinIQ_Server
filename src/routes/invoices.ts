import { Router } from "express";
import { v4 as uuid } from "uuid";
import { z } from "zod";
import {
  appointmentRepository,
  invoiceRepository,
  patientRepository,
} from "../data/postgresStore";
import { requireAuth, requireRole } from "../middleware/auth";
import { Invoice } from "../models/types";

const router = Router();
router.use(requireAuth);

router.get("/", async (_req, res) => {
  const [invoices, patients] = await Promise.all([
    invoiceRepository.list(),
    patientRepository.list(),
  ]);
  const patientMap = new Map(patients.map((p) => [p.id, p]));
  const enriched = invoices.map((i) => ({
    ...i,
    patient: patientMap.get(i.patientId) || null,
  }));
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
