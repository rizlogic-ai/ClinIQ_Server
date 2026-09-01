-- cliniq schema: Doctor-app's clinical scheduling data.
-- Isolated in its own schema on the shared Postgres instance.

CREATE SCHEMA IF NOT EXISTS cliniq;

-- ── Users (doctors + assistants) ──────────────────────────────
CREATE TABLE cliniq.users (
    id             UUID PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    name           TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('doctor', 'assistant')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Doctor <-> Assistant assignments (many-to-many) ───────────
-- A doctor can have many assistants; an assistant can work for many doctors.
CREATE TABLE cliniq.doctor_assistants (
    doctor_id     UUID NOT NULL REFERENCES cliniq.users(id) ON DELETE CASCADE,
    assistant_id  UUID NOT NULL REFERENCES cliniq.users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (doctor_id, assistant_id)
);
CREATE INDEX idx_doctor_assistants_assistant ON cliniq.doctor_assistants(assistant_id);

-- ── Patients ───────────────────────────────────────────────────
CREATE TABLE cliniq.patients (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_patients_phone ON cliniq.patients(phone);

-- ── Appointments ───────────────────────────────────────────────
-- doctor_id records which doctor the assistant booked this for.
CREATE TABLE cliniq.appointments (
    id                UUID PRIMARY KEY,
    patient_id        UUID NOT NULL REFERENCES cliniq.patients(id),
    doctor_id         UUID NOT NULL REFERENCES cliniq.users(id),
    assistant_id      UUID NOT NULL REFERENCES cliniq.users(id),
    reason            TEXT NOT NULL,
    appt_date         DATE NOT NULL,
    appt_time         TIME NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','completed','cancelled')) DEFAULT 'pending',
    doctor_note       TEXT,
    rejection_reason  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointments_doctor_date ON cliniq.appointments(doctor_id, appt_date);
CREATE INDEX idx_appointments_patient ON cliniq.appointments(patient_id);
CREATE INDEX idx_appointments_assistant ON cliniq.appointments(assistant_id);

-- Guardrail: an appointment can only be booked with a doctor the assistant is
-- actually assigned to (mirrors the same check the API performs).
CREATE OR REPLACE FUNCTION cliniq.check_doctor_assistant_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cliniq.doctor_assistants
    WHERE doctor_id = NEW.doctor_id AND assistant_id = NEW.assistant_id
  ) THEN
    RAISE EXCEPTION 'Assistant % is not assigned to doctor %', NEW.assistant_id, NEW.doctor_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_doctor_assistant
  BEFORE INSERT OR UPDATE OF doctor_id, assistant_id ON cliniq.appointments
  FOR EACH ROW EXECUTE FUNCTION cliniq.check_doctor_assistant_assignment();

-- ── Appointment service lines (filled in by doctor on completion) ─
CREATE TABLE cliniq.appointment_services (
    id              UUID PRIMARY KEY,
    appointment_id  UUID NOT NULL REFERENCES cliniq.appointments(id) ON DELETE CASCADE,
    description     TEXT NOT NULL,
    amount          NUMERIC(10,2) NOT NULL CHECK (amount >= 0)
);
CREATE INDEX idx_appointment_services_appt ON cliniq.appointment_services(appointment_id);

-- ── Appointment audit history ─────────────────────────────────
CREATE TABLE cliniq.appointment_history (
    id              BIGSERIAL PRIMARY KEY,
    appointment_id  UUID NOT NULL REFERENCES cliniq.appointments(id) ON DELETE CASCADE,
    actor_id        UUID NOT NULL REFERENCES cliniq.users(id),
    action          TEXT NOT NULL,
    detail          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_appointment_history_appt ON cliniq.appointment_history(appointment_id);

-- ── Invoices ───────────────────────────────────────────────────
CREATE TABLE cliniq.invoices (
    id              UUID PRIMARY KEY,
    appointment_id  UUID NOT NULL REFERENCES cliniq.appointments(id),
    patient_id      UUID NOT NULL REFERENCES cliniq.patients(id),
    total           NUMERIC(10,2) NOT NULL CHECK (total >= 0),
    status          TEXT NOT NULL CHECK (status IN ('unpaid','paid','cancelled')) DEFAULT 'unpaid',
    issued_by       UUID NOT NULL REFERENCES cliniq.users(id),
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at         TIMESTAMPTZ
);
CREATE INDEX idx_invoices_appointment ON cliniq.invoices(appointment_id);
CREATE INDEX idx_invoices_patient ON cliniq.invoices(patient_id);

-- ── Invoice service line snapshot (copied from the appointment at issue time) ─
CREATE TABLE cliniq.invoice_services (
    id          UUID PRIMARY KEY,
    invoice_id  UUID NOT NULL REFERENCES cliniq.invoices(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount      NUMERIC(10,2) NOT NULL CHECK (amount >= 0)
);
CREATE INDEX idx_invoice_services_invoice ON cliniq.invoice_services(invoice_id);
