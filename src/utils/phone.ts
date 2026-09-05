// WhatsApp and SMS both require E.164 (+<country><subscriber>, max 15 digits).
// Clinic staff type numbers however they like — "0300-1234567", "(555) 0100" —
// so everything is normalized before it is stored or sent.

const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "92"; // Pakistan

export function normalizePhone(raw: string, countryCode = DEFAULT_COUNTRY_CODE): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  let national = digits;
  if (hadPlus) {
    // Already international — trust it as given.
    return validate(`+${digits}`);
  }
  if (national.startsWith("00")) {
    return validate(`+${national.slice(2)}`);
  }
  // A leading 0 is a national trunk prefix (0300... -> +92300...).
  if (national.startsWith("0")) {
    national = national.replace(/^0+/, "");
    return validate(`+${countryCode}${national}`);
  }
  // Bare number that already leads with the country code.
  if (national.startsWith(countryCode)) {
    return validate(`+${national}`);
  }
  return validate(`+${countryCode}${national}`);
}

function validate(e164: string): string | null {
  // E.164: '+' then 8-15 digits. Anything shorter is a local/extension number
  // we cannot route (e.g. the old demo "555-0100" seed data).
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}

export function isValidE164(value: string): boolean {
  return /^\+\d{8,15}$/.test(value);
}
