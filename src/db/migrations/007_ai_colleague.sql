-- AI Colleague: a doctor asks a clinical question and gets a second opinion
-- from a language model. Threads are private to the doctor who created them.
--
-- Deliberately holds no patient identifiers: the doctor types the question,
-- nothing is pulled from a chart. Keep it that way unless a data-processing
-- agreement with the model provider is in place.

CREATE TABLE IF NOT EXISTS cliniq.ai_threads (
    id         UUID PRIMARY KEY,
    doctor_id  UUID NOT NULL REFERENCES cliniq.users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_threads_doctor
    ON cliniq.ai_threads(doctor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS cliniq.ai_messages (
    id         UUID PRIMARY KEY,
    thread_id  UUID NOT NULL REFERENCES cliniq.ai_threads(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    -- Which model answered, so a later tier change stays auditable.
    model      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_thread
    ON cliniq.ai_messages(thread_id, created_at);
