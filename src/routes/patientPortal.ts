import { safeRouter } from "../utils/safeRouter";
import { randomUUID, randomInt, createHash } from "crypto";
import { z } from "zod";
import { pool } from "../db/pool";
import { signToken } from "../utils/jwt";
import { requireAuth, requireRole } from "../middleware/auth";
import { normalizePhone } from "../utils/phone";
import { dateField, timeField } from "../utils/datetime";
import { sendMessage } from "../services/messaging";
import { appointmentRepository, clinicRepository, userRepository } from "../data/postgresStore";
import { appointmentRequestedToPatient } from "../services/notifications";

const router = safeRouter();

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;

function hashCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

// ── Request an OTP ────────────────────────────────────────────
router.post("/request-otp", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(4) }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "A phone number is required" });
  }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return res.status(400).json({ error: "That doesn't look like a valid mobile number" });
  }

  const recent = await pool.query(
    `SELECT created_at FROM cliniq.patient_otps
     WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (recent.rows[0]) {
    const elapsed = (Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000;
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      return res.status(429).json({
        error: `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed)}s before requesting another code`,
      });
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query(
    `INSERT INTO cliniq.patient_otps (id, phone_e164, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [randomUUID(), phone, hashCode(code), String(OTP_TTL_MINUTES)]
  );

  const delivery = await sendMessage({
    to: phone,
    kind: "otp",
    body: `Your ClinIQ verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`,
  });

  // Without Twilio configured there is no way to receive the code, so surface
  // it in the dev response rather than locking the developer out entirely.
  const devCode =
    delivery.status === "skipped" && process.env.NODE_ENV !== "production" ? code : undefined;

  res.json({
    sent: delivery.status === "sent",
    delivery: delivery.status,
    ...(devCode ? { devCode } : {}),
  });
});

// ── Verify an OTP ─────────────────────────────────────────────
router.post("/verify-otp", async (req, res) => {
  const parsed = z
    .object({ phone: z.string().min(4), code: z.string().min(4), name: z.string().trim().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Phone and code are required" });
  }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return res.status(400).json({ error: "That doesn't look like a valid mobile number" });
  }

  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts, expires_at, consumed_at
     FROM cliniq.patient_otps
     WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  const otp = rows[0];
  if (!otp || otp.consumed_at) {
    return res.status(400).json({ error: "Request a new code" });
  }
  if (new Date(otp.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: "That code has expired — request a new one" });
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many incorrect attempts — request a new code" });
  }
  if (otp.code_hash !== hashCode(parsed.data.code.trim())) {
    await pool.query(`UPDATE cliniq.patient_otps SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
    return res.status(400).json({ error: "Incorrect code" });
  }

  // Link to an existing patient record when the clinic already has this
  // number on file, so self-booking doesn't create a duplicate chart.
  let patient = await findPatientByPhone(phone);
  if (!patient) {
    const name = parsed.data.name?.trim();
    if (!name) {
      // Leave the code unconsumed — the client is about to resend it with a name.
      return res.status(200).json({ needsName: true });
    }
    const id = randomUUID();
    const inserted = await pool.query(
      `INSERT INTO cliniq.patients (id, name, phone, phone_e164, phone_verified)
       VALUES ($1, $2, $3, $3, true)
       RETURNING id, name, phone, phone_e164, phone_verified`,
      [id, name, phone]
    );
    patient = inserted.rows[0];
  } else if (!patient.phone_verified) {
    await pool.query(
      `UPDATE cliniq.patients SET phone_e164 = $2, phone_verified = true WHERE id = $1`,
      [patient.id, phone]
    );
  }

  await pool.query(`UPDATE cliniq.patient_otps SET consumed_at = now() WHERE id = $1`, [otp.id]);

  const token = signToken({
    sub: patient!.id,
    role: "patient",
    name: patient!.name,
    username: phone,
  });

  res.json({
    token,
    user: { id: patient!.id, name: patient!.name, username: phone, role: "patient" },
  });
});

async function findPatientByPhone(phoneE164: string) {
  const byE164 = await pool.query(
    `SELECT id, name, phone, phone_e164, phone_verified FROM cliniq.patients WHERE phone_e164 = $1`,
    [phoneE164]
  );
  if (byE164.rows[0]) return byE164.rows[0];

  // Fall back to matching legacy rows whose raw phone normalizes to the same
  // number, so patients already in the system keep their history.
  const candidates = await pool.query(
    `SELECT id, name, phone, phone_e164, phone_verified FROM cliniq.patients WHERE phone_e164 IS NULL`
  );
  return candidates.rows.find((r) => normalizePhone(r.phone) === phoneE164);
}

// Clinics and their doctors, for the booking form. Public: a clinic's name
// and the doctors it advertises are not private, and the guest booking form
// needs them before anyone has signed in.
router.get("/clinics", async (_req, res) => {
  const [clinics, users] = await Promise.all([clinicRepository.list(), userRepository.list()]);
  const payload = clinics
    .filter((c) => c.isActive)
    .map((c) => ({
      id: c.id,
      name: c.name,
      city: c.city,
      country: c.country,
      doctors: users
        .filter((u) => u.role === "doctor" && u.isActive && u.clinicId === c.id)
        .map((d) => ({ id: d.id, name: d.name })),
    }))
    .filter((c) => c.doctors.length > 0);
  res.json({ clinics: payload });
});

// ── Guest booking (no account) ────────────────────────────────
// A stopgap until Twilio is live. Deliberately WRITE-ONLY: a guest never
// receives a token, because anyone can type a stranger's number here and a
// token would hand them that person's chart.
const guestBookSchema = z.object({
  name: z.string().trim().min(2),
  phone: z.string().min(4),
  doctorId: z.string().uuid(),
  reason: z.string().trim().min(1),
  date: dateField,
  time: timeField,
});

const GUEST_DAILY_LIMIT = 3;

router.post("/guest-appointments", async (req, res) => {
  const parsed = guestBookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Please fill in every field" });
  }
  const { name, doctorId, reason, date, time } = parsed.data;
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    return res.status(400).json({ error: "That doesn't look like a valid mobile number" });
  }

  const doctor = await userRepository.findById(doctorId);
  if (!doctor || doctor.role !== "doctor" || !doctor.isActive) {
    return res.status(400).json({ error: "That doctor is not available" });
  }
  const clinic = await clinicRepository.findById(doctor.clinicId);
  if (clinic && !clinic.isActive) {
    return res.status(400).json({ error: "That clinic is not accepting bookings" });
  }
  if (new Date(`${date}T${time}`).getTime() < Date.now()) {
    return res.status(400).json({ error: "Pick a date and time in the future" });
  }

  // Without verification the only spam brake is a per-number daily cap.
  const { rows: recent } = await pool.query(
    `SELECT count(*)::int AS n
     FROM cliniq.appointments a
     JOIN cliniq.patients p ON p.id = a.patient_id
     WHERE p.phone_e164 = $1
       AND a.booked_by_patient = true
       AND a.created_at > now() - interval '24 hours'`,
    [phone]
  );
  if (recent[0].n >= GUEST_DAILY_LIMIT) {
    return res.status(429).json({
      error: "You've reached today's booking limit. Please call the clinic instead.",
    });
  }

  // Reuse the chart when the number is already on file; never flip
  // phone_verified, since nothing here proves the number belongs to them.
  let patient = await findPatientByPhone(phone);
  if (!patient) {
    const inserted = await pool.query(
      `INSERT INTO cliniq.patients (id, name, phone, phone_e164, phone_verified)
       VALUES ($1, $2, $3, $3, false)
       RETURNING id, name`,
      [randomUUID(), name, phone]
    );
    patient = inserted.rows[0];
  }

  const now = new Date().toISOString();
  const appointment = await appointmentRepository.create({
    id: randomUUID(),
    patientId: patient!.id,
    doctorId,
    reason,
    date,
    time,
    status: "pending",
    createdBy: patient!.id,
    bookedByPatient: true,
    createdAt: now,
    updatedAt: now,
    services: [],
    history: [
      { timestamp: now, actorId: patient!.id, action: "booked", detail: "Booked by guest (unverified number)" },
    ],
  });

  await appointmentRequestedToPatient(appointment.id);

  // Nothing about the patient's record comes back — just enough to confirm.
  res.status(201).json({
    booked: true,
    appointment: { date: appointment.date, time: appointment.time, reason: appointment.reason },
    doctor: { name: doctor.name },
    clinic: clinic ? { name: clinic.name } : null,
  });
});

// ── Everything below requires a signed-in patient ─────────────
router.use(requireAuth, requireRole("patient"));

router.get("/appointments", async (req, res) => {
  const all = await appointmentRepository.list();
  const mine = all.filter((a) => a.patientId === req.user!.sub);
  const users = await userRepository.list();
  const userMap = new Map(users.map((u) => [u.id, u]));
  res.json({
    appointments: mine
      .map((a) => {
        const doctor = userMap.get(a.doctorId);
        return {
          ...a,
          doctor: doctor ? { id: doctor.id, name: doctor.name } : null,
        };
      })
      .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`)),
  });
});

const bookSchema = z.object({
  doctorId: z.string().uuid(),
  reason: z.string().trim().min(1),
  date: dateField,
  time: timeField,
});

router.post("/appointments", async (req, res) => {
  const parsed = bookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "doctorId, reason, date and time are required" });
  }
  const { doctorId, reason, date, time } = parsed.data;

  const doctor = await userRepository.findById(doctorId);
  if (!doctor || doctor.role !== "doctor" || !doctor.isActive) {
    return res.status(400).json({ error: "That doctor is not available" });
  }
  const clinic = await clinicRepository.findById(doctor.clinicId);
  if (clinic && !clinic.isActive) {
    return res.status(400).json({ error: "That clinic is not accepting bookings" });
  }
  if (new Date(`${date}T${time}`).getTime() < Date.now()) {
    return res.status(400).json({ error: "Pick a date and time in the future" });
  }

  const now = new Date().toISOString();
  const appointment = await appointmentRepository.create({
    id: randomUUID(),
    patientId: req.user!.sub,
    doctorId,
    reason,
    date,
    time,
    status: "pending",
    createdBy: req.user!.sub,
    bookedByPatient: true,
    createdAt: now,
    updatedAt: now,
    services: [],
    history: [{ timestamp: now, actorId: req.user!.sub, action: "booked", detail: "Booked by patient" }],
  });

  await appointmentRequestedToPatient(appointment.id);

  res.status(201).json({ appointment });
});

export default router;
