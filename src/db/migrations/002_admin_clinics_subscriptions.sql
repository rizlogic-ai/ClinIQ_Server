-- Admin module: platform admins, clinics, and per-clinic subscriptions
-- billed by number of doctors.

-- ── Admins ─────────────────────────────────────────────────────
-- Separate from cliniq.users — admins aren't clinic staff, they manage clinics.
CREATE TABLE cliniq.admins (
    id             UUID PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    name           TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Clinics ────────────────────────────────────────────────────
CREATE TABLE cliniq.clinics (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every doctor/assistant now belongs to exactly one clinic.
ALTER TABLE cliniq.users ADD COLUMN clinic_id UUID REFERENCES cliniq.clinics(id);
CREATE INDEX idx_users_clinic ON cliniq.users(clinic_id);

-- ── Subscriptions ──────────────────────────────────────────────
-- One per clinic. Billed amount = price_per_doctor * (doctors currently
-- in that clinic) — computed at query time, not stored, so it never drifts
-- as doctors are added or removed.
CREATE TABLE cliniq.subscriptions (
    id                UUID PRIMARY KEY,
    clinic_id         UUID NOT NULL UNIQUE REFERENCES cliniq.clinics(id) ON DELETE CASCADE,
    price_per_doctor  NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (price_per_doctor >= 0),
    status            TEXT NOT NULL CHECK (status IN ('active', 'paused', 'cancelled')) DEFAULT 'active',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
