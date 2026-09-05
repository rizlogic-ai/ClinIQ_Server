export type StaffRole = "doctor" | "assistant";
export type Role = StaffRole | "admin" | "patient";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
  role: StaffRole;
  clinicId: string;
  isActive: boolean;
}

export interface Admin {
  id: string;
  username: string;
  passwordHash: string;
  name: string;
}

export interface Clinic {
  id: string;
  name: string;
  country?: string;
  city?: string;
  currency: string;
  isActive: boolean;
  createdAt: string;
}

export type SubscriptionStatus = "active" | "paused" | "cancelled";

// Per-doctor pricing tiers: the 1st doctor is billed at tier1Price, the 2nd
// at tier2Price, and every doctor after that at the flat tier3PlusPrice.
export interface Subscription {
  id: string;
  clinicId: string;
  tier1Price: number;
  tier2Price: number;
  tier3PlusPrice: number;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export type AppointmentStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "completed"
  | "cancelled";

export interface Patient {
  id: string;
  name: string;
  phone: string;
  phoneE164?: string;
  phoneVerified?: boolean;
  email?: string;
  notes?: string;
  createdAt: string;
}

export interface ServiceLine {
  id: string;
  description: string;
  amount: number;
}

export interface DoctorAssistant {
  doctorId: string;
  assistantId: string;
}

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  reason: string;
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  status: AppointmentStatus;
  createdBy: string; // assistant user id, or the patient's own id when self-booked
  bookedByPatient?: boolean;
  createdAt: string;
  updatedAt: string;
  doctorNote?: string; // doctor's note on accept/reject/modify
  rejectionReason?: string;
  services: ServiceLine[]; // filled in by doctor after completion
  history: AppointmentHistoryEntry[];
}

export interface AppointmentHistoryEntry {
  timestamp: string;
  actorId: string;
  action: string;
  detail?: string;
}

export type PatientHistorySource = "form" | "scan";

export interface PatientHistoryEntry {
  id: string;
  patientId: string;
  authorId: string;
  title: string;
  notes: string;
  source: PatientHistorySource;
  attachmentDataUrl?: string;
  createdAt: string;
}

export type InvoiceStatus = "unpaid" | "paid" | "cancelled";

export interface Invoice {
  id: string;
  appointmentId: string;
  patientId: string;
  services: ServiceLine[];
  total: number;
  status: InvoiceStatus;
  issuedBy: string; // assistant user id
  issuedAt: string;
  paidAt?: string;
}
