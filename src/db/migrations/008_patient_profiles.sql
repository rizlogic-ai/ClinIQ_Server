-- Structured patient profile: demographics, vitals, lifestyle and history,
-- captured once per patient rather than folded into the free-text patient
-- history log. This is the intake data an eventual disease-prediction model
-- would train against — kept in its own table so it can evolve its own
-- schema independent of the clinical narrative in patient_history.

CREATE TABLE IF NOT EXISTS cliniq.patient_profiles (
    patient_id           UUID PRIMARY KEY REFERENCES cliniq.patients(id) ON DELETE CASCADE,
    date_of_birth        DATE,
    gender               TEXT CHECK (gender IN ('male', 'female', 'other')),
    blood_group          TEXT CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
    height_cm            NUMERIC(5,1) CHECK (height_cm IS NULL OR height_cm > 0),
    weight_kg            NUMERIC(5,1) CHECK (weight_kg IS NULL OR weight_kg > 0),
    smoking              TEXT CHECK (smoking IN ('never','former','current')),
    alcohol              TEXT CHECK (alcohol IN ('never','occasional','regular')),
    exercise             TEXT CHECK (exercise IN ('sedentary','light','active')),
    chronic_conditions   TEXT[] NOT NULL DEFAULT '{}',
    current_medications  TEXT,
    allergies            TEXT,
    family_history       TEXT,
    updated_by           UUID REFERENCES cliniq.users(id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
