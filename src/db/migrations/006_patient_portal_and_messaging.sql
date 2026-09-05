-- Patient self-service portal + WhatsApp messaging support.
--
-- Three things happen here:
--   1. Patients gain a verified E.164 phone so they can log in with an OTP
--      and so WhatsApp messages have somewhere to go.
--   2. Appointments become bookable without an assistant (a patient booking
--      for themselves), which the existing NOT NULL + trigger forbade.
--   3. OTP challenges and message delivery get their own tables.

-- ── 1. Patients: verified phone + self-service account ────────
ALTER TABLE cliniq.patients
    ADD COLUMN IF NOT EXISTS phone_e164     TEXT,
    ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false;

-- One account per verified number. Partial index so the many existing rows
-- with a NULL phone_e164 don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_phone_e164
    ON cliniq.patients(phone_e164)
    WHERE phone_e164 IS NOT NULL;

-- ── 2. Let patients book for themselves ───────────────────────
-- assistant_id NULL == "the patient booked this themselves".
ALTER TABLE cliniq.appointments
    ALTER COLUMN assistant_id DROP NOT NULL;

ALTER TABLE cliniq.appointments
    ADD COLUMN IF NOT EXISTS booked_by_patient BOOLEAN NOT NULL DEFAULT false;

-- The assignment guardrail must now skip patient-booked rows, which have no
-- assistant to check. Staff-booked rows are validated exactly as before.
CREATE OR REPLACE FUNCTION cliniq.check_doctor_assistant_assignment()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.assistant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cliniq.doctor_assistants
    WHERE doctor_id = NEW.doctor_id AND assistant_id = NEW.assistant_id
  ) THEN
    RAISE EXCEPTION 'Assistant % is not assigned to doctor %', NEW.assistant_id, NEW.doctor_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A patient can now be the actor on an appointment's audit trail, so actor_id
-- can no longer be constrained to the staff users table. The column keeps
-- holding a UUID; which table it points at is implied by the action.
ALTER TABLE cliniq.appointment_history
    DROP CONSTRAINT IF EXISTS appointment_history_actor_id_fkey;

-- ── 3. OTP challenges ─────────────────────────────────────────
-- Codes are stored hashed: a leaked table must not let anyone log in.
CREATE TABLE IF NOT EXISTS cliniq.patient_otps (
    id          UUID PRIMARY KEY,
    phone_e164  TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_patient_otps_phone
    ON cliniq.patient_otps(phone_e164, created_at DESC);

-- ── 4. Outbound message log ───────────────────────────────────
-- Every WhatsApp/SMS send attempt, so failures are debuggable and we never
-- silently double-send a confirmation.
CREATE TABLE IF NOT EXISTS cliniq.messages (
    id             UUID PRIMARY KEY,
    appointment_id UUID REFERENCES cliniq.appointments(id) ON DELETE SET NULL,
    to_phone       TEXT NOT NULL,
    channel        TEXT NOT NULL CHECK (channel IN ('whatsapp','sms')),
    kind           TEXT NOT NULL,
    body           TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('sent','failed','skipped')),
    provider_sid   TEXT,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_appointment ON cliniq.messages(appointment_id);
