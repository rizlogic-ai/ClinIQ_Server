import { appointmentRepository, doctorAssistantRepository } from "../data/postgresStore";
import { TokenPayload } from "./jwt";

/**
 * The doctors whose records a staff member may see: a doctor sees their own,
 * an assistant sees the doctors they are assigned to. Anything else sees none.
 */
export async function visibleDoctorIds(user: TokenPayload): Promise<Set<string>> {
  if (user.role === "doctor") return new Set([user.sub]);
  if (user.role === "assistant") {
    const doctors = await doctorAssistantRepository.listDoctorsForAssistant(user.sub);
    return new Set(doctors.map((d) => d.id));
  }
  return new Set();
}

/**
 * Patients are not themselves tied to a clinic — the link is the appointment.
 * A patient is visible when they have at least one appointment with a doctor
 * the caller can see, which keeps one clinic's charts out of another's.
 */
export async function visiblePatientIds(user: TokenPayload): Promise<Set<string>> {
  const doctorIds = await visibleDoctorIds(user);
  if (doctorIds.size === 0) return new Set();
  const appointments = await appointmentRepository.list();
  return new Set(
    appointments.filter((a) => doctorIds.has(a.doctorId)).map((a) => a.patientId)
  );
}
