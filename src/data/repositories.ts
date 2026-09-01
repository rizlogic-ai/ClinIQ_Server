import {
  Admin,
  Appointment,
  Clinic,
  Invoice,
  Patient,
  PatientHistoryEntry,
  StaffRole,
  Subscription,
  SubscriptionStatus,
  User,
} from "../models/types";

export interface UserRepository {
  create(user: {
    username: string;
    passwordHash: string;
    name: string;
    role: StaffRole;
    clinicId: string;
  }): Promise<User>;
  update(
    id: string,
    changes: { name?: string; username?: string; passwordHash?: string; isActive?: boolean }
  ): Promise<User | undefined>;
  delete(id: string): Promise<void>;
  findByUsername(username: string): Promise<User | undefined>;
  findById(id: string): Promise<User | undefined>;
  list(): Promise<User[]>;
  listByClinic(clinicId: string, role?: StaffRole): Promise<User[]>;
}

export interface AdminRepository {
  create(admin: { username: string; passwordHash: string; name: string }): Promise<Admin>;
  findByUsername(username: string): Promise<Admin | undefined>;
  findById(id: string): Promise<Admin | undefined>;
}

export interface ClinicRepository {
  create(data: { name: string; country?: string; city?: string; currency: string }): Promise<Clinic>;
  update(
    id: string,
    changes: { name?: string; country?: string; city?: string; currency?: string; isActive?: boolean }
  ): Promise<Clinic | undefined>;
  delete(id: string): Promise<void>;
  findById(id: string): Promise<Clinic | undefined>;
  list(): Promise<Clinic[]>;
  countDoctors(clinicId: string): Promise<number>;
}

export interface SubscriptionTiers {
  tier1Price: number;
  tier2Price: number;
  tier3PlusPrice: number;
}

export interface SubscriptionRepository {
  create(clinicId: string, tiers: SubscriptionTiers): Promise<Subscription>;
  findByClinicId(clinicId: string): Promise<Subscription | undefined>;
  update(
    clinicId: string,
    changes: Partial<SubscriptionTiers> & { status?: SubscriptionStatus }
  ): Promise<Subscription | undefined>;
}

export interface DoctorAssistantRepository {
  assign(doctorId: string, assistantId: string): Promise<void>;
  unassign(doctorId: string, assistantId: string): Promise<void>;
  isAssigned(doctorId: string, assistantId: string): Promise<boolean>;
  listDoctorsForAssistant(assistantId: string): Promise<User[]>;
  listAssistantsForDoctor(doctorId: string): Promise<User[]>;
}

export interface PatientRepository {
  create(patient: Omit<Patient, "id" | "createdAt">): Promise<Patient>;
  findById(id: string): Promise<Patient | undefined>;
  findByPhone(phone: string): Promise<Patient | undefined>;
  list(): Promise<Patient[]>;
}

export interface PatientHistoryRepository {
  create(entry: Omit<PatientHistoryEntry, "id" | "createdAt">): Promise<PatientHistoryEntry>;
  listByPatient(patientId: string): Promise<PatientHistoryEntry[]>;
}

export interface AppointmentRepository {
  create(appt: Appointment): Promise<Appointment>;
  findById(id: string): Promise<Appointment | undefined>;
  update(id: string, updater: (appt: Appointment) => Appointment): Promise<Appointment | undefined>;
  list(): Promise<Appointment[]>;
}

export interface InvoiceRepository {
  create(invoice: Invoice): Promise<Invoice>;
  findById(id: string): Promise<Invoice | undefined>;
  findByAppointmentId(id: string): Promise<Invoice | undefined>;
  update(id: string, updater: (inv: Invoice) => Invoice): Promise<Invoice | undefined>;
  list(): Promise<Invoice[]>;
}
