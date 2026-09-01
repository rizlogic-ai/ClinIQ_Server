-- Active/inactive lifecycle for clinics and staff, plus tiered per-doctor
-- subscription pricing (1st doctor / 2nd doctor / 3rd+ flat rate), editable
-- per clinic rather than a single fixed rate.

ALTER TABLE cliniq.clinics ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE cliniq.users ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE cliniq.subscriptions DROP COLUMN price_per_doctor;
ALTER TABLE cliniq.subscriptions ADD COLUMN tier1_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (tier1_price >= 0);
ALTER TABLE cliniq.subscriptions ADD COLUMN tier2_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (tier2_price >= 0);
ALTER TABLE cliniq.subscriptions ADD COLUMN tier3_plus_price NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (tier3_plus_price >= 0);
