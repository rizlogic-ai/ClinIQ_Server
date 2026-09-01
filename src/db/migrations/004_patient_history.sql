-- Patient history entries: doctors and assistants can log notes, either
-- typed directly or transcribed from a scanned document, optionally keeping
-- the scanned image alongside the text.

CREATE TABLE cliniq.patient_history (
    id               UUID PRIMARY KEY,
    patient_id       UUID NOT NULL REFERENCES cliniq.patients(id) ON DELETE CASCADE,
    author_id        UUID NOT NULL REFERENCES cliniq.users(id),
    title            TEXT NOT NULL,
    notes            TEXT NOT NULL,
    source           TEXT NOT NULL CHECK (source IN ('form', 'scan')) DEFAULT 'form',
    attachment_data_url TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_patient_history_patient ON cliniq.patient_history(patient_id, created_at DESC);
