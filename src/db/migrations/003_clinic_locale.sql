-- Clinic locale: country, city, and billing currency.

ALTER TABLE cliniq.clinics ADD COLUMN country TEXT;
ALTER TABLE cliniq.clinics ADD COLUMN city TEXT;
ALTER TABLE cliniq.clinics ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
