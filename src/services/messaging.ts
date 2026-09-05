import { randomUUID } from "crypto";
import { pool } from "../db/pool";

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;
const SMS_FROM = process.env.TWILIO_SMS_FROM;

export type Channel = "whatsapp" | "sms";

export function isMessagingConfigured(): boolean {
  return Boolean(ACCOUNT_SID && AUTH_TOKEN && (WHATSAPP_FROM || SMS_FROM));
}

interface SendArgs {
  to: string; // E.164
  body: string;
  kind: string; // "otp" | "appointment_booked" | "appointment_confirmed" | ...
  channel?: Channel;
  appointmentId?: string;
}

interface SendResult {
  status: "sent" | "failed" | "skipped";
  sid?: string;
  error?: string;
}

/**
 * Sends a message and always records the attempt. Never throws — a messaging
 * outage must not roll back the booking that triggered it.
 */
export async function sendMessage({
  to,
  body,
  kind,
  channel = "whatsapp",
  appointmentId,
}: SendArgs): Promise<SendResult> {
  const from = channel === "whatsapp" ? WHATSAPP_FROM : SMS_FROM ?? WHATSAPP_FROM;

  let result: SendResult;
  if (!ACCOUNT_SID || !AUTH_TOKEN || !from) {
    result = { status: "skipped", error: "Twilio is not configured" };
  } else {
    result = await deliver({ accountSid: ACCOUNT_SID, authToken: AUTH_TOKEN, from, to, body, channel });
  }

  await log({ appointmentId, to, channel, kind, body, result });
  return result;
}

async function deliver(args: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  body: string;
  channel: Channel;
}): Promise<SendResult> {
  const prefix = args.channel === "whatsapp" ? "whatsapp:" : "";
  // TWILIO_WHATSAPP_FROM may already carry the scheme; don't double it.
  const from = args.from.startsWith("whatsapp:") ? args.from : `${prefix}${args.from}`;
  const to = args.to.startsWith("whatsapp:") ? args.to : `${prefix}${args.to}`;

  const form = new URLSearchParams({ From: from, To: to, Body: args.body });
  const auth = Buffer.from(`${args.accountSid}:${args.authToken}`).toString("base64");

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${args.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );
    const payload = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok) {
      return { status: "failed", error: payload.message ?? `Twilio responded ${res.status}` };
    }
    return { status: "sent", sid: payload.sid };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "Network error" };
  }
}

async function log(args: {
  appointmentId?: string;
  to: string;
  channel: Channel;
  kind: string;
  body: string;
  result: SendResult;
}) {
  try {
    await pool.query(
      `INSERT INTO cliniq.messages
         (id, appointment_id, to_phone, channel, kind, body, status, provider_sid, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        randomUUID(),
        args.appointmentId ?? null,
        args.to,
        args.channel,
        args.kind,
        // OTP codes must never be recoverable from the log.
        args.kind === "otp" ? "[redacted]" : args.body,
        args.result.status,
        args.result.sid ?? null,
        args.result.error ?? null,
      ]
    );
  } catch {
    // Logging is best-effort; the send already happened.
  }
}
