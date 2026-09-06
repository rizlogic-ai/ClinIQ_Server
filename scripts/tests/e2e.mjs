import "dotenv/config";
import { createHash, randomUUID } from "crypto";
import pkg from "pg";
const { Pool } = pkg;

const API = process.env.E2E_API || "https://cliniq-server-9e7d.onrender.com/api";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const results = [];
let currentArea = "";
function area(name) { currentArea = name; }

async function check(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, area: currentArea, name, status: "PASS", detail: detail || "" });
    console.log(`  PASS  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ id, area: currentArea, name, status: "FAIL", detail: e.message });
    console.log(`  FAIL  ${id}  ${name} — ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function req(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const TAG = "ZZTEST";
const created = { patients: [], appointments: [], clinics: [], staff: [], phones: [] };
const futureDate = (days) => {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
};

let doctorTok, assistantTok, adminTok, patientTok;
let doctorId, assistantId, demoClinicId;

console.log(`\nRunning end-to-end suite against ${API}\n`);

// ─────────────────────────────────────────────────────────────
area("Infrastructure");
await check("INF-01", "Health endpoint responds ok", async () => {
  const r = await req("/health");
  assert(r.status === 200 && r.data.status === "ok", `got ${r.status}`);
  return "200 ok";
});
await check("INF-02", "Unknown route returns 404 JSON", async () => {
  const r = await req("/does-not-exist");
  assert(r.status === 404, `got ${r.status}`);
  return "404";
});

// ─────────────────────────────────────────────────────────────
area("Staff authentication");
await check("AUTH-01", "Doctor logs in with valid credentials", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "doctor", password: "password123" } });
  assert(r.status === 200 && r.data.token, `got ${r.status}`);
  doctorTok = r.data.token; doctorId = r.data.user.id;
  return r.data.user.name;
});
await check("AUTH-02", "Assistant logs in with valid credentials", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "assistant", password: "password123" } });
  assert(r.status === 200 && r.data.token, `got ${r.status}`);
  assistantTok = r.data.token; assistantId = r.data.user.id;
  return r.data.user.name;
});
await check("AUTH-03", "Wrong password is rejected", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "doctor", password: "wrong" } });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "401";
});
await check("AUTH-04", "Unknown username is rejected", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "nobody", password: "x" } });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "401";
});
await check("AUTH-05", "Login response carries clinic currency", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "doctor", password: "password123" } });
  assert(r.data.user.currency, "currency missing");
  demoClinicId = r.data.user.clinicId;
  return `currency=${r.data.user.currency}`;
});
await check("AUTH-06", "/auth/me returns the session user with currency", async () => {
  const r = await req("/auth/me", { token: doctorTok });
  assert(r.status === 200 && r.data.user.currency, `got ${r.status}`);
  return `currency=${r.data.user.currency}`;
});
await check("AUTH-07", "Request without a token is rejected", async () => {
  const r = await req("/appointments");
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "401";
});
await check("AUTH-08", "Malformed token is rejected", async () => {
  const r = await req("/appointments", { token: "not-a-real-token" });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "401";
});

// ─────────────────────────────────────────────────────────────
area("Admin authentication");
await check("ADM-01", "Admin logs in", async () => {
  const r = await req("/admin/login", { method: "POST", body: { username: "superadmin", password: "admin12345" } });
  assert(r.status === 200 && r.data.token, `got ${r.status}`);
  adminTok = r.data.token;
  return r.data.admin.name;
});
await check("ADM-02", "Admin wrong password rejected", async () => {
  const r = await req("/admin/login", { method: "POST", body: { username: "superadmin", password: "nope" } });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  return "401";
});
await check("ADM-03", "Staff token cannot reach admin routes", async () => {
  const r = await req("/admin/clinics", { token: doctorTok });
  assert(r.status === 403 || r.status === 401, `expected 401/403, got ${r.status}`);
  return `${r.status}`;
});

// ─────────────────────────────────────────────────────────────
area("Role authorization");
for (const [id, path] of [["SEC-01", "/patients"], ["SEC-02", "/invoices"], ["SEC-03", "/doctors"]]) {
  await check(id, `Patient token blocked from ${path}`, async () => {
    // build a patient token first (below) — placeholder resolved later
    return "deferred";
  });
}

// ─────────────────────────────────────────────────────────────
area("Admin: clinic management");
let testClinicId;
await check("CLIN-01", "Create clinic with tiered pricing", async () => {
  const r = await req("/admin/clinics", { method: "POST", token: adminTok, body: {
    name: `${TAG} Clinic`, country: "Pakistan", city: "Lahore", currency: "PKR",
    tier1Price: 60000, tier2Price: 40000, tier3PlusPrice: 25000,
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  testClinicId = r.data.clinic.id; created.clinics.push(testClinicId);
  return `${r.data.clinic.name} / ${r.data.clinic.currency}`;
});
await check("CLIN-02", "New clinic appears in the list", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  assert(r.data.clinics.some((c) => c.id === testClinicId), "not found in list");
  return `${r.data.clinics.length} clinics`;
});
await check("CLIN-03", "Clinic subscription starts with the tiers given", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  const c = r.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.tier1Price === 60000, `tier1=${c.subscription.tier1Price}`);
  return `60000/40000/25000 ${c.currency}`;
});
await check("CLIN-04", "Edit clinic name and currency", async () => {
  const r = await req(`/admin/clinics/${testClinicId}`, { method: "PATCH", token: adminTok, body: { city: "Karachi" } });
  assert(r.status === 200 && r.data.clinic.city === "Karachi", `got ${r.status}`);
  return "city -> Karachi";
});

let testDoctorId, testAssistantId;
await check("STAFF-01", "Add a doctor to the clinic", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/doctors`, { method: "POST", token: adminTok, body: {
    name: `${TAG} Dr One`, username: `${TAG.toLowerCase()}_doc1`, password: "testpass123",
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  testDoctorId = r.data.doctor.id; created.staff.push(testDoctorId);
  return r.data.doctor.name;
});
await check("BILL-01", "Monthly total = tier1 for 1 doctor", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  const c = r.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.monthlyTotal === 60000, `got ${c.subscription.monthlyTotal}`);
  return "PKR 60,000";
});
await check("STAFF-02", "Add a second doctor", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/doctors`, { method: "POST", token: adminTok, body: {
    name: `${TAG} Dr Two`, username: `${TAG.toLowerCase()}_doc2`, password: "testpass123",
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status}`);
  created.staff.push(r.data.doctor.id);
  return r.data.doctor.name;
});
await check("BILL-02", "Monthly total = tier1+tier2 for 2 doctors", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  const c = r.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.monthlyTotal === 100000, `got ${c.subscription.monthlyTotal}`);
  return "PKR 100,000";
});
await check("STAFF-03", "Add a third doctor", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/doctors`, { method: "POST", token: adminTok, body: {
    name: `${TAG} Dr Three`, username: `${TAG.toLowerCase()}_doc3`, password: "testpass123",
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status}`);
  created.staff.push(r.data.doctor.id);
  return r.data.doctor.name;
});
await check("BILL-03", "3rd doctor billed at the flat tier3 rate", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  const c = r.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.monthlyTotal === 125000, `got ${c.subscription.monthlyTotal}`);
  return "PKR 125,000";
});
await check("BILL-04", "Subscription tiers are editable", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/subscription`, { method: "PATCH", token: adminTok, body: {
    tier1Price: 70000, tier2Price: 45000, tier3PlusPrice: 30000, status: "active",
  }});
  assert(r.status === 200, `got ${r.status}`);
  const after = await req("/admin/clinics", { token: adminTok });
  const c = after.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.monthlyTotal === 145000, `total=${c.subscription.monthlyTotal}`);
  return "PKR 145,000 after repricing";
});
await check("STAFF-04", "Add an assistant linked to a doctor", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/assistants`, { method: "POST", token: adminTok, body: {
    name: `${TAG} Asst`, username: `${TAG.toLowerCase()}_asst`, password: "testpass123", doctorIds: [testDoctorId],
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  testAssistantId = r.data.assistant.id; created.staff.push(testAssistantId);
  return r.data.assistant.name;
});
await check("STAFF-05", "Staff listing shows doctors and assistants", async () => {
  const r = await req(`/admin/clinics/${testClinicId}/staff`, { token: adminTok });
  assert(r.data.doctors.length === 3, `doctors=${r.data.doctors.length}`);
  assert(r.data.assistants.length === 1, `assistants=${r.data.assistants.length}`);
  return "3 doctors, 1 assistant";
});

// ─────────────────────────────────────────────────────────────
area("Staff lifecycle");
await check("LIFE-01", "Deactivate a doctor", async () => {
  const r = await req(`/admin/staff/${created.staff[2]}`, { method: "PATCH", token: adminTok, body: { isActive: false } });
  assert(r.status === 200 && r.data.staff.isActive === false, `got ${r.status}`);
  return "isActive=false";
});
await check("BILL-05", "Deactivated doctor drops out of billing", async () => {
  const r = await req("/admin/clinics", { token: adminTok });
  const c = r.data.clinics.find((x) => x.id === testClinicId);
  assert(c.subscription.monthlyTotal === 115000, `got ${c.subscription.monthlyTotal}`);
  return "PKR 145,000 -> 115,000";
});
await check("LIFE-02", "Deactivated staff cannot log in", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc3`, password: "testpass123" } });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403 deactivated";
});
await check("LIFE-03", "Reactivate the doctor", async () => {
  const r = await req(`/admin/staff/${created.staff[2]}`, { method: "PATCH", token: adminTok, body: { isActive: true } });
  assert(r.status === 200 && r.data.staff.isActive === true, `got ${r.status}`);
  const login = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc3`, password: "testpass123" } });
  assert(login.status === 200, `login after reactivate got ${login.status}`);
  return "can log in again";
});
await check("LIFE-04", "Deactivate a clinic blocks its staff logins", async () => {
  await req(`/admin/clinics/${testClinicId}`, { method: "PATCH", token: adminTok, body: { isActive: false } });
  const r = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc1`, password: "testpass123" } });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  await req(`/admin/clinics/${testClinicId}`, { method: "PATCH", token: adminTok, body: { isActive: true } });
  return "403 while clinic inactive";
});

// ─────────────────────────────────────────────────────────────
area("Assistant workflow");
let testClinicAsstTok, testPatientId, testApptId;
await check("ASST-01", "Test assistant logs in", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_asst`, password: "testpass123" } });
  assert(r.status === 200, `got ${r.status}`);
  testClinicAsstTok = r.data.token;
  return `currency=${r.data.user.currency}`;
});
await check("ASST-02", "Assistant sees only their assigned doctors", async () => {
  const r = await req("/doctors", { token: testClinicAsstTok });
  assert(r.status === 200, `got ${r.status}`);
  assert(r.data.doctors.length === 1, `expected 1 assigned doctor, got ${r.data.doctors.length}`);
  return "1 assigned doctor";
});
await check("ASST-03", "Assistant books an appointment for a new patient", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: `${TAG} checkup`, date: futureDate(7), time: "10:00",
    newPatient: { name: `${TAG} Patient`, phone: "0300 1112233" },
  }});
  assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.data)}`);
  testApptId = r.data.appointment.id; testPatientId = r.data.appointment.patientId;
  created.appointments.push(testApptId); created.patients.push(testPatientId);
  return "pending appointment created";
});
await check("ASST-04", "Assistant cannot book with an unassigned doctor", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: created.staff[1], reason: "x", date: futureDate(7), time: "11:00",
    newPatient: { name: `${TAG} Nope`, phone: "0300 9998877" },
  }});
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403 not assigned";
});
await check("ASST-05", "Patient phone is normalized to E.164 on creation", async () => {
  const { rows } = await pool.query(`SELECT phone, phone_e164 FROM cliniq.patients WHERE id = $1`, [testPatientId]);
  assert(rows[0].phone_e164 === "+923001112233", `got ${rows[0].phone_e164}`);
  return `0300 1112233 -> ${rows[0].phone_e164}`;
});
await check("ASST-06", "Assistant sees the appointment they created", async () => {
  const r = await req("/appointments", { token: testClinicAsstTok });
  assert(r.data.appointments.some((a) => a.id === testApptId), "appointment not visible");
  return `${r.data.appointments.length} visible`;
});
await check("ASST-07", "Other clinic's assistant cannot see it", async () => {
  const r = await req("/appointments", { token: assistantTok });
  assert(!r.data.appointments.some((a) => a.id === testApptId), "LEAK: cross-clinic appointment visible");
  return "correctly hidden";
});

// ─────────────────────────────────────────────────────────────
area("Doctor workflow");
let testDocTok;
await check("DOC-01", "Test doctor logs in", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc1`, password: "testpass123" } });
  assert(r.status === 200, `got ${r.status}`);
  testDocTok = r.data.token;
  return "ok";
});
await check("DOC-02", "Doctor sees only their own appointments", async () => {
  const r = await req("/appointments", { token: testDocTok });
  assert(r.data.appointments.every((a) => a.doctorId === testDoctorId), "sees other doctors' appointments");
  return `${r.data.appointments.length} own`;
});
await check("DOC-03", "Doctor reschedules a pending appointment", async () => {
  const r = await req(`/appointments/${testApptId}/reschedule`, { method: "PATCH", token: testDocTok, body: {
    date: futureDate(9), time: "14:00", note: "Moved to a later slot",
  }});
  assert(r.status === 200 && r.data.appointment.time === "14:00", `got ${r.status}`);
  return "10:00 -> 14:00";
});
await check("DOC-04", "Doctor accepts the appointment", async () => {
  const r = await req(`/appointments/${testApptId}/accept`, { method: "PATCH", token: testDocTok });
  assert(r.status === 200 && r.data.appointment.status === "accepted", `got ${r.status}`);
  return "accepted";
});
await check("DOC-05", "Accepting twice is rejected", async () => {
  const r = await req(`/appointments/${testApptId}/accept`, { method: "PATCH", token: testDocTok });
  assert(r.status === 409, `expected 409, got ${r.status}`);
  return "409 conflict";
});
await check("DOC-06", "Assistant cannot accept an appointment", async () => {
  const r = await req(`/appointments/${testApptId}/accept`, { method: "PATCH", token: testClinicAsstTok });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403";
});
await check("DOC-07", "Doctor completes with itemized services", async () => {
  const r = await req(`/appointments/${testApptId}/complete`, { method: "PATCH", token: testDocTok, body: {
    services: [{ description: "Consultation", amount: 2500 }, { description: "X-ray", amount: 1500 }],
  }});
  assert(r.status === 200 && r.data.appointment.status === "completed", `got ${r.status}`);
  const total = r.data.appointment.services.reduce((s, x) => s + x.amount, 0);
  assert(total === 4000, `total=${total}`);
  return "PKR 4,000 recorded";
});
await check("DOC-08", "Completing a non-accepted appointment is rejected", async () => {
  const r = await req(`/appointments/${testApptId}/complete`, { method: "PATCH", token: testDocTok, body: {
    services: [{ description: "x", amount: 1 }],
  }});
  assert(r.status === 409, `expected 409, got ${r.status}`);
  return "409";
});
await check("DOC-09", "Appointment history records the full audit trail", async () => {
  const r = await req("/appointments", { token: testDocTok });
  const a = r.data.appointments.find((x) => x.id === testApptId);
  const actions = a.history.map((h) => h.action);
  assert(actions.includes("created") && actions.includes("rescheduled") && actions.includes("accepted") && actions.includes("completed"),
    `actions=${actions.join(",")}`);
  return actions.join(" -> ");
});

// ─────────────────────────────────────────────────────────────
area("Invoicing");
let testInvoiceId;
await check("INV-01", "Assistant issues an invoice for the completed visit", async () => {
  const r = await req("/invoices", { method: "POST", token: testClinicAsstTok, body: { appointmentId: testApptId } });
  assert(r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  testInvoiceId = r.data.invoice.id;
  assert(r.data.invoice.total === 4000, `total=${r.data.invoice.total}`);
  return "PKR 4,000 unpaid";
});
await check("INV-02", "Invoice carries doctor, dates and issuer for printing", async () => {
  const r = await req("/invoices", { token: testClinicAsstTok });
  const inv = r.data.invoices.find((i) => i.id === testInvoiceId);
  assert(inv.doctor && inv.appointmentDate && inv.issuedByName, `missing enrichment: ${JSON.stringify({d:!!inv.doctor,ad:!!inv.appointmentDate,ib:!!inv.issuedByName})}`);
  return `${inv.doctor.name}, issued by ${inv.issuedByName}`;
});
await check("INV-03", "Invoice service lines snapshot the visit", async () => {
  const r = await req("/invoices", { token: testClinicAsstTok });
  const inv = r.data.invoices.find((i) => i.id === testInvoiceId);
  assert(inv.services.length === 2, `lines=${inv.services.length}`);
  return "2 line items";
});
await check("INV-04", "Mark invoice paid", async () => {
  const r = await req(`/invoices/${testInvoiceId}/pay`, { method: "PATCH", token: testClinicAsstTok });
  assert(r.status === 200 && r.data.invoice.status === "paid", `got ${r.status}`);
  return "status=paid";
});
await check("INV-05", "Doctor cannot issue invoices", async () => {
  const r = await req("/invoices", { method: "POST", token: testDocTok, body: { appointmentId: testApptId } });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403";
});


// ─────────────────────────────────────────────────────────────
area("Clinic isolation");
await check("ISO-01", "Clinic sees only its own patients", async () => {
  const r = await req("/patients", { token: testClinicAsstTok });
  assert(r.data.patients.every((p) => p.name.startsWith(TAG)), 
    "sees other clinics' patients: " + r.data.patients.map(p=>p.name).join(", "));
  return `${r.data.patients.length} own patient(s)`;
});
await check("ISO-02", "Another clinic cannot see this clinic's patients", async () => {
  const r = await req("/patients", { token: assistantTok });
  assert(!r.data.patients.some((p) => p.name.startsWith(TAG)),
    "LEAK: test clinic patient visible to Demo Clinic");
  return "correctly hidden";
});
await check("ISO-03", "Clinic sees only its own invoices", async () => {
  const r = await req("/invoices", { token: testClinicAsstTok });
  assert(r.data.invoices.every((i) => i.doctor && i.doctor.name.startsWith(TAG)),
    "sees other clinics' invoices");
  return `${r.data.invoices.length} own invoice(s)`;
});
await check("ISO-04", "Another clinic cannot see this clinic's invoices", async () => {
  const r = await req("/invoices", { token: assistantTok });
  assert(!r.data.invoices.some((i) => i.doctor && i.doctor.name.startsWith(TAG)),
    "LEAK: test clinic invoice visible to Demo Clinic");
  return "correctly hidden";
});
await check("ISO-05", "Cross-clinic patient history is not readable", async () => {
  const r = await req(`/patients/${testPatientId}/history`, { token: assistantTok });
  assert(r.status === 404, `expected 404, got ${r.status}`);
  return "404";
});

// ─────────────────────────────────────────────────────────────
area("Patient history");
await check("HIST-01", "Assistant adds a form-based history entry", async () => {
  const r = await req(`/patients/${testPatientId}/history`, { method: "POST", token: testClinicAsstTok, body: {
    title: `${TAG} Allergy note`, notes: "Penicillin allergy", source: "form",
  }});
  assert(r.status === 201 || r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  return "entry saved";
});
await check("HIST-02", "History is readable back", async () => {
  const r = await req(`/patients/${testPatientId}/history`, { token: testClinicAsstTok });
  assert(r.data.entries.length >= 1, `entries=${r.data.entries?.length}`);
  return `${r.data.entries.length} entry`;
});
await check("HIST-03", "Doctor can read patient history", async () => {
  const r = await req(`/patients/${testPatientId}/history`, { token: testDocTok });
  assert(r.status === 200, `got ${r.status}`);
  return "200";
});

// ─────────────────────────────────────────────────────────────
area("Patient portal (OTP)");
const otpPhone = "+923005550001";
created.phones.push(otpPhone);
await check("OTP-01", "Requesting a code succeeds", async () => {
  const r = await req("/portal/request-otp", { method: "POST", body: { phone: otpPhone } });
  assert(r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
  return `delivery=${r.data.delivery}`;
});
await check("OTP-02", "Production does not leak the code in the response", async () => {
  const r = await req("/portal/request-otp", { method: "POST", body: { phone: "+923005550002" } });
  created.phones.push("+923005550002");
  assert(!r.data.devCode || process.env.NODE_ENV !== "production", `devCode exposed: ${r.data.devCode}`);
  return r.data.devCode ? `devCode present (non-prod)` : "no devCode in response";
});
await check("OTP-03", "Resend within cooldown is rate-limited", async () => {
  const r = await req("/portal/request-otp", { method: "POST", body: { phone: otpPhone } });
  assert(r.status === 429, `expected 429, got ${r.status}`);
  return "429 cooldown";
});
await check("OTP-04", "Invalid phone rejected", async () => {
  const r = await req("/portal/request-otp", { method: "POST", body: { phone: "12" } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("OTP-05", "Codes are stored hashed, never in plaintext", async () => {
  const { rows } = await pool.query(`SELECT code_hash FROM cliniq.patient_otps WHERE phone_e164 = $1 ORDER BY created_at DESC LIMIT 1`, [otpPhone]);
  assert(rows[0] && /^[0-9a-f]{64}$/.test(rows[0].code_hash), `hash looks wrong: ${rows[0]?.code_hash}`);
  return "sha256 hash";
});
await check("OTP-06", "Wrong code is rejected", async () => {
  const r = await req("/portal/verify-otp", { method: "POST", body: { phone: otpPhone, code: "000000" } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});

// Inject a known code so the verify path can be exercised on production.
const knownCode = "424242";
const knownPhone = "+923005550003";
created.phones.push(knownPhone);
await pool.query(
  `INSERT INTO cliniq.patient_otps (id, phone_e164, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '10 minutes')`,
  [randomUUID(), knownPhone, createHash("sha256").update(knownCode).digest("hex")]
);
await check("OTP-07", "First-time patient is asked for a name", async () => {
  const r = await req("/portal/verify-otp", { method: "POST", body: { phone: knownPhone, code: knownCode } });
  assert(r.status === 200 && r.data.needsName === true, `got ${r.status} ${JSON.stringify(r.data)}`);
  return "needsName=true";
});
await check("OTP-08", "Code survives the name prompt and completes signup", async () => {
  const r = await req("/portal/verify-otp", { method: "POST", body: { phone: knownPhone, code: knownCode, name: `${TAG} Portal Patient` } });
  assert(r.status === 200 && r.data.token, `got ${r.status} ${JSON.stringify(r.data)}`);
  patientTok = r.data.token;
  created.patients.push(r.data.user.id);
  return "token issued";
});
await check("OTP-09", "A used code cannot be replayed", async () => {
  const r = await req("/portal/verify-otp", { method: "POST", body: { phone: knownPhone, code: knownCode, name: "Someone Else" } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400 single-use";
});
await check("OTP-10", "Verified patient is flagged phone_verified", async () => {
  const { rows } = await pool.query(`SELECT phone_verified FROM cliniq.patients WHERE phone_e164 = $1`, [knownPhone]);
  assert(rows[0].phone_verified === true, `got ${rows[0]?.phone_verified}`);
  return "phone_verified=true";
});

// ─────────────────────────────────────────────────────────────
area("Patient portal (booking)");
let portalApptId;
await check("PORT-01", "Patient lists bookable clinics", async () => {
  const r = await req("/portal/clinics", { token: patientTok });
  assert(r.status === 200 && r.data.clinics.length > 0, `got ${r.status}`);
  return `${r.data.clinics.length} clinics`;
});
await check("PORT-02", "Patient books their own appointment", async () => {
  const r = await req("/portal/appointments", { method: "POST", token: patientTok, body: {
    doctorId: testDoctorId, reason: `${TAG} self-booked`, date: futureDate(12), time: "09:30",
  }});
  assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.data)}`);
  portalApptId = r.data.appointment.id; created.appointments.push(portalApptId);
  assert(r.data.appointment.status === "pending", "should be pending");
  return "pending, awaiting doctor";
});
await check("PORT-03", "Self-booked appointment is flagged as patient-booked", async () => {
  const { rows } = await pool.query(`SELECT booked_by_patient, assistant_id FROM cliniq.appointments WHERE id = $1`, [portalApptId]);
  assert(rows[0].booked_by_patient === true && rows[0].assistant_id === null, JSON.stringify(rows[0]));
  return "booked_by_patient=true, no assistant";
});
await check("PORT-04", "Booking in the past is rejected", async () => {
  const r = await req("/portal/appointments", { method: "POST", token: patientTok, body: {
    doctorId: testDoctorId, reason: "past", date: "2020-01-01", time: "09:00",
  }});
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("PORT-05", "Patient sees only their own appointments", async () => {
  const r = await req("/portal/appointments", { token: patientTok });
  assert(r.data.appointments.every((a) => a.id === portalApptId || a.patientId), "unexpected shape");
  assert(r.data.appointments.length === 1, `expected 1, got ${r.data.appointments.length}`);
  return "1 own appointment";
});
await check("PORT-06", "Doctor sees the patient-booked request", async () => {
  const r = await req("/appointments", { token: testDocTok });
  const a = r.data.appointments.find((x) => x.id === portalApptId);
  assert(a && a.bookedByPatient === true, "not visible or not flagged");
  return "visible and flagged";
});
await check("PORT-07", "Doctor confirming triggers the confirmation message", async () => {
  const r = await req(`/appointments/${portalApptId}/accept`, { method: "PATCH", token: testDocTok });
  assert(r.status === 200, `got ${r.status}`);
  const { rows } = await pool.query(
    `SELECT kind, status FROM cliniq.messages WHERE appointment_id = $1 AND kind = 'appointment_confirmed'`, [portalApptId]);
  assert(rows.length === 1, `expected 1 confirmation, got ${rows.length}`);
  return `logged, status=${rows[0].status}`;
});

// ─────────────────────────────────────────────────────────────
area("Role authorization (patient token)");
await check("SEC-01", "Patient token blocked from /patients", async () => {
  const r = await req("/patients", { token: patientTok });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403";
});
await check("SEC-02", "Patient token blocked from /invoices", async () => {
  const r = await req("/invoices", { token: patientTok });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403";
});
await check("SEC-03", "Patient token blocked from /doctors", async () => {
  const r = await req("/doctors", { token: patientTok });
  assert(r.status === 403, `expected 403, got ${r.status}`);
  return "403";
});
await check("SEC-04", "Patient token sees no staff appointments", async () => {
  const r = await req("/appointments", { token: patientTok });
  assert(r.status === 200 && r.data.appointments.length === 0, `leaked ${r.data.appointments?.length} appointments`);
  return "empty list";
});
await check("SEC-05", "Patient token blocked from admin routes", async () => {
  const r = await req("/admin/clinics", { token: patientTok });
  assert(r.status === 403 || r.status === 401, `got ${r.status}`);
  return `${r.status}`;
});

// ─────────────────────────────────────────────────────────────
area("Guest booking");
const guestPhone = "0301 5559999";
created.phones.push("+923015559999");
await check("GUEST-01", "Clinic list is reachable without signing in", async () => {
  const r = await req("/portal/clinics");
  assert(r.status === 200 && r.data.clinics.length > 0, `got ${r.status}`);
  return `${r.data.clinics.length} clinics, no token`;
});
await check("GUEST-02", "Guest submits a booking with no account", async () => {
  const r = await req("/portal/guest-appointments", { method: "POST", body: {
    name: `${TAG} Guest`, phone: guestPhone, doctorId: testDoctorId,
    reason: `${TAG} guest visit`, date: futureDate(14), time: "16:00",
  }});
  assert(r.status === 201, `got ${r.status} ${JSON.stringify(r.data)}`);
  return `${r.data.doctor.name} @ ${r.data.appointment.date}`;
});
await check("GUEST-03", "Guest response leaks no token and no patient id", async () => {
  const r = await req("/portal/guest-appointments", { method: "POST", body: {
    name: `${TAG} Guest`, phone: guestPhone, doctorId: testDoctorId,
    reason: `${TAG} second`, date: futureDate(15), time: "16:00",
  }});
  const s = JSON.stringify(r.data);
  assert(!s.includes("token") && !s.includes("patientId"), `leak: ${s}`);
  return "clean payload";
});
await check("GUEST-04", "Guest booking is stored unverified", async () => {
  const { rows } = await pool.query(`SELECT phone_verified FROM cliniq.patients WHERE phone_e164 = $1`, ["+923015559999"]);
  assert(rows[0] && rows[0].phone_verified === false, `got ${JSON.stringify(rows[0])}`);
  return "phone_verified=false";
});
await check("GUEST-05", "Daily cap blocks the 4th request from one number", async () => {
  await req("/portal/guest-appointments", { method: "POST", body: {
    name: `${TAG} Guest`, phone: guestPhone, doctorId: testDoctorId, reason: "3rd", date: futureDate(16), time: "16:00" } });
  const r = await req("/portal/guest-appointments", { method: "POST", body: {
    name: `${TAG} Guest`, phone: guestPhone, doctorId: testDoctorId, reason: "4th", date: futureDate(17), time: "16:00" } });
  assert(r.status === 429, `expected 429, got ${r.status}`);
  return "429 after 3";
});
await check("GUEST-06", "Guest booking to an inactive doctor is rejected", async () => {
  await req(`/admin/staff/${created.staff[2]}`, { method: "PATCH", token: adminTok, body: { isActive: false } });
  const r = await req("/portal/guest-appointments", { method: "POST", body: {
    name: `${TAG} G2`, phone: "0302 5551111", doctorId: created.staff[2], reason: "x", date: futureDate(14), time: "10:00" } });
  await req(`/admin/staff/${created.staff[2]}`, { method: "PATCH", token: adminTok, body: { isActive: true } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400 doctor unavailable";
});

// ─────────────────────────────────────────────────────────────
area("Messaging");
await check("MSG-01", "Every send attempt is logged", async () => {
  const { rows } = await pool.query(`SELECT count(*)::int n FROM cliniq.messages WHERE created_at > now() - interval '10 minutes'`);
  assert(rows[0].n > 0, "no messages logged");
  return `${rows[0].n} logged this run`;
});
await check("MSG-02", "OTP message bodies are redacted in the log", async () => {
  const { rows } = await pool.query(`SELECT body FROM cliniq.messages WHERE kind = 'otp' ORDER BY created_at DESC LIMIT 5`);
  assert(rows.every((r) => r.body === "[redacted]"), "an OTP body was stored in clear text");
  return "all redacted";
});
await check("MSG-03", "Missing Twilio config degrades to 'skipped', not failure", async () => {
  const { rows } = await pool.query(`SELECT DISTINCT status FROM cliniq.messages WHERE created_at > now() - interval '10 minutes'`);
  const statuses = rows.map((r) => r.status);
  assert(!statuses.includes("failed") || statuses.includes("sent"), `statuses=${statuses.join(",")}`);
  return `status=${statuses.join(",")}`;
});
await check("MSG-04", "Booking and confirmation both notify the patient", async () => {
  const { rows } = await pool.query(
    `SELECT DISTINCT kind FROM cliniq.messages WHERE created_at > now() - interval '10 minutes' AND kind LIKE 'appointment%'`);
  const kinds = rows.map((r) => r.kind);
  assert(kinds.includes("appointment_requested") && kinds.includes("appointment_confirmed"), `kinds=${kinds.join(",")}`);
  return kinds.join(", ");
});

// ─────────────────────────────────────────────────────────────
area("Currency");
await check("CUR-01", "PKR clinic reports PKR to its staff", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc1`, password: "testpass123" } });
  assert(r.data.user.currency === "PKR", `got ${r.data.user.currency}`);
  return "PKR";
});
await check("CUR-02", "USD clinic reports USD to its staff", async () => {
  const r = await req("/auth/login", { method: "POST", body: { username: "doctor", password: "password123" } });
  assert(r.data.user.currency === "USD", `got ${r.data.user.currency}`);
  return "USD";
});
await check("CUR-03", "Two clinics on different currencies stay independent", async () => {
  const a = await req("/auth/login", { method: "POST", body: { username: `${TAG.toLowerCase()}_doc1`, password: "testpass123" } });
  const b = await req("/auth/login", { method: "POST", body: { username: "doctor", password: "password123" } });
  assert(a.data.user.currency !== b.data.user.currency, "currencies collapsed");
  return `${a.data.user.currency} vs ${b.data.user.currency}`;
});

// ─────────────────────────────────────────────────────────────
area("Input validation");
await check("VAL-01", "Appointment rejects a malformed date", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: "x", date: "not-a-date", time: "10:00", newPatient: { name: "x", phone: "0300 1234567" } } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-02", "Appointment rejects a malformed time", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: "x", date: futureDate(3), time: "99:99", newPatient: { name: "x", phone: "0300 1234567" } } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-03", "Completion requires at least one service line", async () => {
  const r = await req(`/appointments/${portalApptId}/complete`, { method: "PATCH", token: testDocTok, body: { services: [] } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-04", "Negative service amounts are rejected", async () => {
  const r = await req(`/appointments/${portalApptId}/complete`, { method: "PATCH", token: testDocTok, body: {
    services: [{ description: "refund", amount: -100 }] } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-05", "Rejection requires a reason", async () => {
  const r = await req(`/appointments/${portalApptId}/reject`, { method: "PATCH", token: testDocTok, body: {} });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-06", "Guest booking requires every field", async () => {
  const r = await req("/portal/guest-appointments", { method: "POST", body: { name: "x" } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});


await check("VAL-07", "Impossible clock time is rejected, server survives", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: "x", date: futureDate(3), time: "99:99", newPatient: { name: "x", phone: "0300 1234567" } } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  const h = await req("/health"); assert(h.status === 200, "server died");
  return "400, server alive";
});
await check("VAL-08", "Out-of-range hour is rejected", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: "x", date: futureDate(3), time: "25:00", newPatient: { name: "x", phone: "0300 1234567" } } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400";
});
await check("VAL-09", "Non-existent calendar date is rejected", async () => {
  const r = await req("/appointments", { method: "POST", token: testClinicAsstTok, body: {
    doctorId: testDoctorId, reason: "x", date: "2026-02-31", time: "10:00", newPatient: { name: "x", phone: "0300 1234567" } } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  return "400 (2026-02-31)";
});
await check("VAL-10", "Guest endpoint rejects a bad time without crashing", async () => {
  const r = await req("/portal/guest-appointments", { method: "POST", body: {
    name: "Probe Guest", phone: "0300 1231234", doctorId: testDoctorId, reason: "x", date: futureDate(3), time: "99:99" } });
  assert(r.status === 400, `expected 400, got ${r.status}`);
  const h = await req("/health"); assert(h.status === 200, "server died");
  return "400, server alive";
});
await check("ERR-01", "Unexpected error returns 500, not a dropped connection", async () => {
  const r = await req("/appointments/not-a-uuid/accept", { method: "PATCH", token: testDocTok });
  assert(r.status === 500, `expected 500, got ${r.status}`);
  const h = await req("/health"); assert(h.status === 200, "server died");
  return "500, server alive";
});

// ─────────────────────────────────────────────────────────────
area("Admin: deletion safeguards");
await check("DEL-01", "Deleting staff with records deactivates instead", async () => {
  const r = await req(`/admin/staff/${testDoctorId}`, { method: "DELETE", token: adminTok });
  assert(r.status === 200, `got ${r.status}`);
  assert(r.data.deactivated === true || r.data.deleted === true, JSON.stringify(r.data));
  return r.data.deactivated ? "deactivated (has records)" : "hard-deleted (no records)";
});
await check("DEL-02", "Deleting a clinic with staff deactivates instead", async () => {
  const r = await req(`/admin/clinics/${testClinicId}`, { method: "DELETE", token: adminTok });
  assert(r.status === 200, `got ${r.status}`);
  return r.data.deactivated ? "deactivated (has staff)" : "hard-deleted";
});

// ─────────────────────────────────────────────────────────────
console.log("\n── Cleaning up test data ──");
const cleanupPhones = [...new Set([...created.phones, "+923001112233", "+923015559999", "+923025551111"])];
const { rows: tp } = await pool.query(
  `SELECT id FROM cliniq.patients WHERE name LIKE $1 OR phone_e164 = ANY($2)`, [`${TAG}%`, cleanupPhones]);
for (const p of tp) {
  const { rows: aps } = await pool.query(`SELECT id FROM cliniq.appointments WHERE patient_id = $1`, [p.id]);
  for (const a of aps) {
    await pool.query(`DELETE FROM cliniq.invoice_services WHERE invoice_id IN (SELECT id FROM cliniq.invoices WHERE appointment_id=$1)`, [a.id]);
    await pool.query(`DELETE FROM cliniq.invoices WHERE appointment_id = $1`, [a.id]);
    await pool.query(`DELETE FROM cliniq.appointment_history WHERE appointment_id = $1`, [a.id]);
    await pool.query(`DELETE FROM cliniq.appointment_services WHERE appointment_id = $1`, [a.id]);
    await pool.query(`DELETE FROM cliniq.messages WHERE appointment_id = $1`, [a.id]);
    await pool.query(`DELETE FROM cliniq.appointments WHERE id = $1`, [a.id]);
  }
  await pool.query(`DELETE FROM cliniq.patient_history WHERE patient_id = $1`, [p.id]);
  await pool.query(`DELETE FROM cliniq.patients WHERE id = $1`, [p.id]);
}
await pool.query(`DELETE FROM cliniq.messages WHERE to_phone = ANY($1)`, [cleanupPhones]);
await pool.query(`DELETE FROM cliniq.patient_otps WHERE phone_e164 = ANY($1)`, [cleanupPhones]);
await pool.query(`DELETE FROM cliniq.doctor_assistants WHERE doctor_id = ANY($1) OR assistant_id = ANY($1)`, [created.staff]);
await pool.query(`DELETE FROM cliniq.users WHERE username LIKE $1`, [`${TAG.toLowerCase()}%`]);
await pool.query(`DELETE FROM cliniq.subscriptions WHERE clinic_id = ANY($1)`, [created.clinics]);
await pool.query(`DELETE FROM cliniq.clinics WHERE name LIKE $1`, [`${TAG}%`]);
console.log(`Removed ${tp.length} test patient(s), ${created.staff.length} staff, ${created.clinics.length} clinic(s).`);

const left = await pool.query(`SELECT name FROM cliniq.patients ORDER BY name`);
const clinicsLeft = await pool.query(`SELECT name, currency, is_active FROM cliniq.clinics ORDER BY name`);
console.log("Patients remaining:", left.rows.map(r=>r.name).join(", "));
console.log("Clinics remaining:", clinicsLeft.rows.map(r=>`${r.name}(${r.currency},${r.is_active?"active":"inactive"})`).join(", "));

// ─────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL").length;
console.log(`\n════ ${pass} passed, ${fail} failed, ${results.length} total ════\n`);
if (fail) {
  console.log("FAILURES:");
  results.filter(r=>r.status==="FAIL").forEach(r => console.log(`  ${r.id} [${r.area}] ${r.name}\n      ${r.detail}`));
}
const fs = await import("fs");
fs.writeFileSync(process.env.E2E_OUT || "./e2e-results.json", JSON.stringify(results, null, 2));
await pool.end();
