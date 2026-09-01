import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool";
import {
  AdminRepository,
  AppointmentRepository,
  ClinicRepository,
  DoctorAssistantRepository,
  InvoiceRepository,
  PatientHistoryRepository,
  PatientRepository,
  SubscriptionRepository,
  SubscriptionTiers,
  UserRepository,
} from "./repositories";
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

const USER_COLUMNS = "id, username, password_hash, name, role, clinic_id, is_active";

function mapUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    name: row.name,
    role: row.role,
    clinicId: row.clinic_id,
    isActive: row.is_active,
  };
}

class PostgresUserRepository implements UserRepository {
  async create(user: {
    username: string;
    passwordHash: string;
    name: string;
    role: StaffRole;
    clinicId: string;
  }) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.users (id, username, password_hash, name, role, clinic_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${USER_COLUMNS}`,
      [uuid(), user.username, user.passwordHash, user.name, user.role, user.clinicId]
    );
    return mapUser(rows[0]);
  }

  async findByUsername(username: string) {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM cliniq.users WHERE lower(username) = lower($1)`,
      [username]
    );
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async findById(id: string) {
    const { rows } = await pool.query(
      `SELECT ${USER_COLUMNS} FROM cliniq.users WHERE id = $1`,
      [id]
    );
    return rows[0] ? mapUser(rows[0]) : undefined;
  }

  async list() {
    const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM cliniq.users ORDER BY name`);
    return rows.map(mapUser);
  }

  async listByClinic(clinicId: string, role?: StaffRole) {
    const { rows } = await pool.query(
      role
        ? `SELECT ${USER_COLUMNS} FROM cliniq.users WHERE clinic_id = $1 AND role = $2 ORDER BY name`
        : `SELECT ${USER_COLUMNS} FROM cliniq.users WHERE clinic_id = $1 ORDER BY name`,
      role ? [clinicId, role] : [clinicId]
    );
    return rows.map(mapUser);
  }

  async update(
    id: string,
    changes: { name?: string; username?: string; passwordHash?: string; isActive?: boolean }
  ) {
    const current = await this.findById(id);
    if (!current) return undefined;
    const name = changes.name ?? current.name;
    const username = changes.username ?? current.username;
    const passwordHash = changes.passwordHash ?? current.passwordHash;
    const isActive = changes.isActive ?? current.isActive;
    const { rows } = await pool.query(
      `UPDATE cliniq.users SET name = $2, username = $3, password_hash = $4, is_active = $5
       WHERE id = $1
       RETURNING ${USER_COLUMNS}`,
      [id, name, username, passwordHash, isActive]
    );
    return mapUser(rows[0]);
  }

  async delete(id: string) {
    await pool.query(`DELETE FROM cliniq.users WHERE id = $1`, [id]);
  }
}

function mapAdmin(row: any): Admin {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    name: row.name,
  };
}

class PostgresAdminRepository implements AdminRepository {
  async create(admin: { username: string; passwordHash: string; name: string }) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.admins (id, username, password_hash, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, password_hash, name`,
      [uuid(), admin.username, admin.passwordHash, admin.name]
    );
    return mapAdmin(rows[0]);
  }

  async findByUsername(username: string) {
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, name FROM cliniq.admins WHERE lower(username) = lower($1)`,
      [username]
    );
    return rows[0] ? mapAdmin(rows[0]) : undefined;
  }

  async findById(id: string) {
    const { rows } = await pool.query(
      `SELECT id, username, password_hash, name FROM cliniq.admins WHERE id = $1`,
      [id]
    );
    return rows[0] ? mapAdmin(rows[0]) : undefined;
  }
}

function mapClinic(row: any): Clinic {
  return {
    id: row.id,
    name: row.name,
    country: row.country ?? undefined,
    city: row.city ?? undefined,
    currency: row.currency,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

class PostgresClinicRepository implements ClinicRepository {
  async create(data: { name: string; country?: string; city?: string; currency: string }) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.clinics (id, name, country, city, currency)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [uuid(), data.name, data.country ?? null, data.city ?? null, data.currency]
    );
    return mapClinic(rows[0]);
  }

  async update(
    id: string,
    changes: { name?: string; country?: string; city?: string; currency?: string; isActive?: boolean }
  ) {
    const current = await this.findById(id);
    if (!current) return undefined;
    const name = changes.name ?? current.name;
    const country = changes.country ?? current.country ?? null;
    const city = changes.city ?? current.city ?? null;
    const currency = changes.currency ?? current.currency;
    const isActive = changes.isActive ?? current.isActive;
    const { rows } = await pool.query(
      `UPDATE cliniq.clinics SET name = $2, country = $3, city = $4, currency = $5, is_active = $6
       WHERE id = $1
       RETURNING *`,
      [id, name, country, city, currency, isActive]
    );
    return mapClinic(rows[0]);
  }

  async delete(id: string) {
    await pool.query(`DELETE FROM cliniq.clinics WHERE id = $1`, [id]);
  }

  async findById(id: string) {
    const { rows } = await pool.query(`SELECT * FROM cliniq.clinics WHERE id = $1`, [id]);
    return rows[0] ? mapClinic(rows[0]) : undefined;
  }

  async list() {
    const { rows } = await pool.query(`SELECT * FROM cliniq.clinics ORDER BY name`);
    return rows.map(mapClinic);
  }

  async countDoctors(clinicId: string) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count FROM cliniq.users WHERE clinic_id = $1 AND role = 'doctor' AND is_active = true`,
      [clinicId]
    );
    return rows[0].count as number;
  }
}

function mapSubscription(row: any): Subscription {
  return {
    id: row.id,
    clinicId: row.clinic_id,
    tier1Price: Number(row.tier1_price),
    tier2Price: Number(row.tier2_price),
    tier3PlusPrice: Number(row.tier3_plus_price),
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

class PostgresSubscriptionRepository implements SubscriptionRepository {
  async create(clinicId: string, tiers: SubscriptionTiers) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.subscriptions (id, clinic_id, tier1_price, tier2_price, tier3_plus_price)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [uuid(), clinicId, tiers.tier1Price, tiers.tier2Price, tiers.tier3PlusPrice]
    );
    return mapSubscription(rows[0]);
  }

  async findByClinicId(clinicId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM cliniq.subscriptions WHERE clinic_id = $1`,
      [clinicId]
    );
    return rows[0] ? mapSubscription(rows[0]) : undefined;
  }

  async update(
    clinicId: string,
    changes: Partial<SubscriptionTiers> & { status?: SubscriptionStatus }
  ) {
    const current = await this.findByClinicId(clinicId);
    if (!current) return undefined;
    const tier1Price = changes.tier1Price ?? current.tier1Price;
    const tier2Price = changes.tier2Price ?? current.tier2Price;
    const tier3PlusPrice = changes.tier3PlusPrice ?? current.tier3PlusPrice;
    const status = changes.status ?? current.status;
    const { rows } = await pool.query(
      `UPDATE cliniq.subscriptions
       SET tier1_price = $2, tier2_price = $3, tier3_plus_price = $4, status = $5, updated_at = now()
       WHERE clinic_id = $1
       RETURNING *`,
      [clinicId, tier1Price, tier2Price, tier3PlusPrice, status]
    );
    return mapSubscription(rows[0]);
  }
}

class PostgresDoctorAssistantRepository implements DoctorAssistantRepository {
  async assign(doctorId: string, assistantId: string) {
    await pool.query(
      `INSERT INTO cliniq.doctor_assistants (doctor_id, assistant_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [doctorId, assistantId]
    );
  }

  async unassign(doctorId: string, assistantId: string) {
    await pool.query(
      `DELETE FROM cliniq.doctor_assistants WHERE doctor_id = $1 AND assistant_id = $2`,
      [doctorId, assistantId]
    );
  }

  async isAssigned(doctorId: string, assistantId: string) {
    const { rows } = await pool.query(
      `SELECT 1 FROM cliniq.doctor_assistants WHERE doctor_id = $1 AND assistant_id = $2`,
      [doctorId, assistantId]
    );
    return rows.length > 0;
  }

  async listDoctorsForAssistant(assistantId: string) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.name, u.role, u.clinic_id, u.is_active
       FROM cliniq.users u
       JOIN cliniq.doctor_assistants da ON da.doctor_id = u.id
       WHERE da.assistant_id = $1 AND u.is_active = true
       ORDER BY u.name`,
      [assistantId]
    );
    return rows.map(mapUser);
  }

  async listAssistantsForDoctor(doctorId: string) {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.password_hash, u.name, u.role, u.clinic_id, u.is_active
       FROM cliniq.users u
       JOIN cliniq.doctor_assistants da ON da.assistant_id = u.id
       WHERE da.doctor_id = $1
       ORDER BY u.name`,
      [doctorId]
    );
    return rows.map(mapUser);
  }
}

function mapPatient(row: any): Patient {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

class PostgresPatientRepository implements PatientRepository {
  async create(patient: Omit<Patient, "id" | "createdAt">) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.patients (id, name, phone, email, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, email, notes, created_at`,
      [uuid(), patient.name, patient.phone, patient.email ?? null, patient.notes ?? null]
    );
    return mapPatient(rows[0]);
  }

  async findById(id: string) {
    const { rows } = await pool.query(`SELECT * FROM cliniq.patients WHERE id = $1`, [id]);
    return rows[0] ? mapPatient(rows[0]) : undefined;
  }

  async findByPhone(phone: string) {
    const { rows } = await pool.query(
      `SELECT * FROM cliniq.patients WHERE phone = $1 LIMIT 1`,
      [phone]
    );
    return rows[0] ? mapPatient(rows[0]) : undefined;
  }

  async list() {
    const { rows } = await pool.query(`SELECT * FROM cliniq.patients ORDER BY name`);
    return rows.map(mapPatient);
  }
}

function mapPatientHistory(row: any): PatientHistoryEntry {
  return {
    id: row.id,
    patientId: row.patient_id,
    authorId: row.author_id,
    title: row.title,
    notes: row.notes,
    source: row.source,
    attachmentDataUrl: row.attachment_data_url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

class PostgresPatientHistoryRepository implements PatientHistoryRepository {
  async create(entry: Omit<PatientHistoryEntry, "id" | "createdAt">) {
    const { rows } = await pool.query(
      `INSERT INTO cliniq.patient_history (id, patient_id, author_id, title, notes, source, attachment_data_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        uuid(),
        entry.patientId,
        entry.authorId,
        entry.title,
        entry.notes,
        entry.source,
        entry.attachmentDataUrl ?? null,
      ]
    );
    return mapPatientHistory(rows[0]);
  }

  async listByPatient(patientId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM cliniq.patient_history WHERE patient_id = $1 ORDER BY created_at DESC`,
      [patientId]
    );
    return rows.map(mapPatientHistory);
  }
}

const APPOINTMENT_SELECT = `
  SELECT
    a.id,
    a.patient_id,
    a.doctor_id,
    a.assistant_id,
    a.reason,
    to_char(a.appt_date, 'YYYY-MM-DD') AS date,
    to_char(a.appt_time, 'HH24:MI') AS time,
    a.status,
    a.doctor_note,
    a.rejection_reason,
    a.created_at,
    a.updated_at,
    COALESCE((
      SELECT json_agg(json_build_object('id', s.id, 'description', s.description, 'amount', s.amount) ORDER BY s.id)
      FROM cliniq.appointment_services s WHERE s.appointment_id = a.id
    ), '[]'::json) AS services,
    COALESCE((
      SELECT json_agg(json_build_object('timestamp', h.created_at, 'actorId', h.actor_id, 'action', h.action, 'detail', h.detail) ORDER BY h.created_at)
      FROM cliniq.appointment_history h WHERE h.appointment_id = a.id
    ), '[]'::json) AS history
  FROM cliniq.appointments a
`;

function mapAppointment(row: any): Appointment {
  return {
    id: row.id,
    patientId: row.patient_id,
    doctorId: row.doctor_id,
    reason: row.reason,
    date: row.date,
    time: row.time,
    status: row.status,
    createdBy: row.assistant_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    doctorNote: row.doctor_note ?? undefined,
    rejectionReason: row.rejection_reason ?? undefined,
    services: row.services.map((s: any) => ({
      id: s.id,
      description: s.description,
      amount: Number(s.amount),
    })),
    history: row.history.map((h: any) => ({
      timestamp: new Date(h.timestamp).toISOString(),
      actorId: h.actorId,
      action: h.action,
      detail: h.detail ?? undefined,
    })),
  };
}

class PostgresAppointmentRepository implements AppointmentRepository {
  async create(appt: Appointment) {
    await pool.query(
      `INSERT INTO cliniq.appointments
         (id, patient_id, doctor_id, assistant_id, reason, appt_date, appt_time, status, doctor_note, rejection_reason, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        appt.id,
        appt.patientId,
        appt.doctorId,
        appt.createdBy,
        appt.reason,
        appt.date,
        appt.time,
        appt.status,
        appt.doctorNote ?? null,
        appt.rejectionReason ?? null,
        appt.createdAt,
        appt.updatedAt,
      ]
    );
    for (const s of appt.services) {
      await pool.query(
        `INSERT INTO cliniq.appointment_services (id, appointment_id, description, amount) VALUES ($1, $2, $3, $4)`,
        [s.id, appt.id, s.description, s.amount]
      );
    }
    for (const h of appt.history) {
      await pool.query(
        `INSERT INTO cliniq.appointment_history (appointment_id, actor_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [appt.id, h.actorId, h.action, h.detail ?? null, h.timestamp]
      );
    }
    return appt;
  }

  async findById(id: string) {
    const { rows } = await pool.query(`${APPOINTMENT_SELECT} WHERE a.id = $1`, [id]);
    return rows[0] ? mapAppointment(rows[0]) : undefined;
  }

  async update(id: string, updater: (appt: Appointment) => Appointment) {
    const current = await this.findById(id);
    if (!current) return undefined;
    const updated = updater(current);

    await pool.query(
      `UPDATE cliniq.appointments
       SET status = $2, appt_date = $3, appt_time = $4, doctor_note = $5, rejection_reason = $6, updated_at = $7
       WHERE id = $1`,
      [
        id,
        updated.status,
        updated.date,
        updated.time,
        updated.doctorNote ?? null,
        updated.rejectionReason ?? null,
        updated.updatedAt,
      ]
    );

    if (updated.history.length > current.history.length) {
      for (const h of updated.history.slice(current.history.length)) {
        await pool.query(
          `INSERT INTO cliniq.appointment_history (appointment_id, actor_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [id, h.actorId, h.action, h.detail ?? null, h.timestamp]
        );
      }
    }

    if (updated.services.length !== current.services.length) {
      await pool.query(`DELETE FROM cliniq.appointment_services WHERE appointment_id = $1`, [id]);
      for (const s of updated.services) {
        await pool.query(
          `INSERT INTO cliniq.appointment_services (id, appointment_id, description, amount) VALUES ($1, $2, $3, $4)`,
          [s.id, id, s.description, s.amount]
        );
      }
    }

    return this.findById(id);
  }

  async list() {
    const { rows } = await pool.query(`${APPOINTMENT_SELECT} ORDER BY a.appt_date, a.appt_time`);
    return rows.map(mapAppointment);
  }
}

const INVOICE_SELECT = `
  SELECT
    i.id,
    i.appointment_id,
    i.patient_id,
    i.total,
    i.status,
    i.issued_by,
    i.issued_at,
    i.paid_at,
    COALESCE((
      SELECT json_agg(json_build_object('id', s.id, 'description', s.description, 'amount', s.amount) ORDER BY s.id)
      FROM cliniq.invoice_services s WHERE s.invoice_id = i.id
    ), '[]'::json) AS services
  FROM cliniq.invoices i
`;

function mapInvoice(row: any): Invoice {
  return {
    id: row.id,
    appointmentId: row.appointment_id,
    patientId: row.patient_id,
    services: row.services.map((s: any) => ({
      id: s.id,
      description: s.description,
      amount: Number(s.amount),
    })),
    total: Number(row.total),
    status: row.status,
    issuedBy: row.issued_by,
    issuedAt: new Date(row.issued_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : undefined,
  };
}

class PostgresInvoiceRepository implements InvoiceRepository {
  async create(invoice: Invoice) {
    await pool.query(
      `INSERT INTO cliniq.invoices (id, appointment_id, patient_id, total, status, issued_by, issued_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        invoice.id,
        invoice.appointmentId,
        invoice.patientId,
        invoice.total,
        invoice.status,
        invoice.issuedBy,
        invoice.issuedAt,
        invoice.paidAt ?? null,
      ]
    );
    for (const s of invoice.services) {
      await pool.query(
        `INSERT INTO cliniq.invoice_services (id, invoice_id, description, amount) VALUES ($1, $2, $3, $4)`,
        [s.id, invoice.id, s.description, s.amount]
      );
    }
    return invoice;
  }

  async findById(id: string) {
    const { rows } = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [id]);
    return rows[0] ? mapInvoice(rows[0]) : undefined;
  }

  async findByAppointmentId(appointmentId: string) {
    const { rows } = await pool.query(`${INVOICE_SELECT} WHERE i.appointment_id = $1`, [
      appointmentId,
    ]);
    return rows[0] ? mapInvoice(rows[0]) : undefined;
  }

  async update(id: string, updater: (inv: Invoice) => Invoice) {
    const current = await this.findById(id);
    if (!current) return undefined;
    const updated = updater(current);
    await pool.query(`UPDATE cliniq.invoices SET status = $2, paid_at = $3 WHERE id = $1`, [
      id,
      updated.status,
      updated.paidAt ?? null,
    ]);
    return this.findById(id);
  }

  async list() {
    const { rows } = await pool.query(`${INVOICE_SELECT} ORDER BY i.issued_at DESC`);
    return rows.map(mapInvoice);
  }
}

export const userRepository = new PostgresUserRepository();
export const adminRepository = new PostgresAdminRepository();
export const clinicRepository = new PostgresClinicRepository();
export const subscriptionRepository = new PostgresSubscriptionRepository();
export const doctorAssistantRepository = new PostgresDoctorAssistantRepository();
export const patientRepository = new PostgresPatientRepository();
export const patientHistoryRepository = new PostgresPatientHistoryRepository();
export const appointmentRepository = new PostgresAppointmentRepository();
export const invoiceRepository = new PostgresInvoiceRepository();

async function upsertDemoUser(
  username: string,
  name: string,
  role: StaffRole,
  clinicId: string,
  passwordHash: string
) {
  await pool.query(
    `INSERT INTO cliniq.users (id, username, password_hash, name, role, clinic_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username) DO NOTHING`,
    [uuid(), username, passwordHash, name, role, clinicId]
  );
  // Backfills clinic_id for rows created before that column existed.
  await pool.query(
    `UPDATE cliniq.users SET clinic_id = $2 WHERE username = $1 AND clinic_id IS NULL`,
    [username, clinicId]
  );
  const { rows } = await pool.query(`SELECT id FROM cliniq.users WHERE username = $1`, [username]);
  return rows[0].id as string;
}

async function upsertDemoClinic(name: string) {
  const { rows: existing } = await pool.query(`SELECT id FROM cliniq.clinics WHERE name = $1`, [
    name,
  ]);
  if (existing[0]) return existing[0].id as string;
  const clinic = await clinicRepository.create({ name, currency: "USD" });
  return clinic.id;
}

export async function seedDemoData() {
  const passwordHash = await bcrypt.hash("password123", 10);

  const clinicId = await upsertDemoClinic("Demo Clinic");
  const demoSubscription = await subscriptionRepository.findByClinicId(clinicId);
  if (!demoSubscription) {
    await subscriptionRepository.create(clinicId, {
      tier1Price: 350,
      tier2Price: 250,
      tier3PlusPrice: 150,
    });
  } else if (
    demoSubscription.tier1Price === 0 &&
    demoSubscription.tier2Price === 0 &&
    demoSubscription.tier3PlusPrice === 0
  ) {
    // Backfills a subscription created before per-tier pricing existed.
    await subscriptionRepository.update(clinicId, {
      tier1Price: 350,
      tier2Price: 250,
      tier3PlusPrice: 150,
    });
  }

  const doctor1Id = await upsertDemoUser("doctor", "Dr. Sara Khan", "doctor", clinicId, passwordHash);
  const doctor2Id = await upsertDemoUser("doctor2", "Dr. Imran Ali", "doctor", clinicId, passwordHash);
  const assistant1Id = await upsertDemoUser(
    "assistant",
    "Amina Yousuf",
    "assistant",
    clinicId,
    passwordHash
  );
  const assistant2Id = await upsertDemoUser(
    "assistant2",
    "Bilal Ahmed",
    "assistant",
    clinicId,
    passwordHash
  );

  // Amina works for both doctors; Bilal works for Dr. Khan only.
  await doctorAssistantRepository.assign(doctor1Id, assistant1Id);
  await doctorAssistantRepository.assign(doctor2Id, assistant1Id);
  await doctorAssistantRepository.assign(doctor1Id, assistant2Id);
}
