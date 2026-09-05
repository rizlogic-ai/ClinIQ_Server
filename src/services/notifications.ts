import { appointmentRepository, patientRepository, userRepository, clinicRepository } from "../data/postgresStore";
import { normalizePhone } from "../utils/phone";
import { sendMessage } from "./messaging";

function prettyDate(date: string, time: string) {
  const d = new Date(`${date}T${time}`);
  if (Number.isNaN(d.getTime())) return `${date} at ${time}`;
  return d.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

async function context(appointmentId: string) {
  const appointment = await appointmentRepository.findById(appointmentId);
  if (!appointment) return null;
  const [patient, doctor] = await Promise.all([
    patientRepository.findById(appointment.patientId),
    userRepository.findById(appointment.doctorId),
  ]);
  if (!patient) return null;

  const to = patient.phoneE164 ?? normalizePhone(patient.phone);
  if (!to) return null; // No routable number — nothing to send to.

  const clinic = doctor ? await clinicRepository.findById(doctor.clinicId) : undefined;
  return { appointment, patient, doctor, clinic, to };
}

/** Sent when a booking is first created — sets expectations that it is not yet confirmed. */
export async function appointmentRequestedToPatient(appointmentId: string) {
  const ctx = await context(appointmentId);
  if (!ctx) return;
  const { appointment, doctor, clinic, to } = ctx;
  await sendMessage({
    to,
    appointmentId,
    kind: "appointment_requested",
    body:
      `Hello ${ctx.patient.name}, your appointment request with ${doctor?.name ?? "your doctor"}` +
      `${clinic ? ` at ${clinic.name}` : ""} for ${prettyDate(appointment.date, appointment.time)} ` +
      `has been received. We'll message you again once the doctor confirms it.`,
  });
}

/** Sent when the doctor accepts — this is the actual confirmation. */
export async function appointmentConfirmedToPatient(appointmentId: string) {
  const ctx = await context(appointmentId);
  if (!ctx) return;
  const { appointment, doctor, clinic, to } = ctx;
  await sendMessage({
    to,
    appointmentId,
    kind: "appointment_confirmed",
    body:
      `Good news ${ctx.patient.name} — your appointment is CONFIRMED.\n\n` +
      `Doctor: ${doctor?.name ?? "—"}\n` +
      `When: ${prettyDate(appointment.date, appointment.time)}\n` +
      `${clinic ? `Where: ${clinic.name}${clinic.city ? `, ${clinic.city}` : ""}\n` : ""}` +
      `Reason: ${appointment.reason}\n\n` +
      `Please arrive 10 minutes early. Reply to this message if you need to reschedule.`,
  });
}

/** Sent when the doctor rejects or the visit is cancelled. */
export async function appointmentCancelledToPatient(appointmentId: string, reason?: string) {
  const ctx = await context(appointmentId);
  if (!ctx) return;
  const { appointment, doctor, to } = ctx;
  await sendMessage({
    to,
    appointmentId,
    kind: "appointment_cancelled",
    body:
      `Hello ${ctx.patient.name}, your appointment with ${doctor?.name ?? "your doctor"} on ` +
      `${prettyDate(appointment.date, appointment.time)} has been cancelled.` +
      `${reason ? `\n\nReason: ${reason}` : ""}\n\nPlease contact the clinic to rebook.`,
  });
}

/** Sent when the appointment is moved to a new slot. */
export async function appointmentRescheduledToPatient(appointmentId: string) {
  const ctx = await context(appointmentId);
  if (!ctx) return;
  const { appointment, doctor, to } = ctx;
  await sendMessage({
    to,
    appointmentId,
    kind: "appointment_rescheduled",
    body:
      `Hello ${ctx.patient.name}, your appointment with ${doctor?.name ?? "your doctor"} has been ` +
      `moved to ${prettyDate(appointment.date, appointment.time)}. ` +
      `Reply to this message if that time doesn't work for you.`,
  });
}
