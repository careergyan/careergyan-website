// send-confirmation-email (updated 2026-11-18)
// What changed:
//   - FIX: the student's name now shows. The table column is full_name; the old code read registration.name,
//     which does not exist, so "Dear ___" was blank.
//   - the email shows which event the student registered for (form name, date, time, venue from public.forms)
//   - the admin email subject and body include the form name, so admins can tell registrations apart
//   - emails are not sent twice for the same registration (confirmation_email_sent is checked)
// Everything else (Resend, from/reply-to addresses, paid-only check, layout) is as before.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;

const FROM_EMAIL = "CareerGyan <noreply@events.careergyan.co>";
const REPLY_TO = "marketingcareergyan@gmail.com";
const ADMIN_EMAIL = "marketingcareergyan@gmail.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function response(
  data: Record<string, unknown>,
  status = 200
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function row(label: string, value: string, last = false): string {
  const border = last ? "" : "border-bottom:1px solid #eeeeee;";
  return `<tr><td style="${border}"><strong>${label}</strong></td><td style="${border}">${value}</td></tr>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    if (!RESEND_API_KEY) {
      console.error("RESEND_API_KEY is missing");
      return response({ success: false, error: "RESEND_API_KEY is not configured" }, 500);
    }

    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.error("SUPABASE_SERVICE_ROLE_KEY is missing");
      return response(
        { success: false, error: "Supabase service role key is not configured" },
        500
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (error) {
      console.error("Invalid JSON request:", error);
      return response({ success: false, error: "Invalid JSON request body" }, 400);
    }

    const registrationId = body.registrationId;

    if (registrationId === undefined || registrationId === null || registrationId === "") {
      console.error("Missing registrationId");
      return response({ success: false, error: "registrationId is required" }, 400);
    }

    console.log("Processing confirmation email for registration:", registrationId);

    // ==========================================
    // REGISTRATION
    // ==========================================

    const { data: registration, error: registrationError } = await supabase
      .from("registrations")
      .select("*")
      .eq("id", registrationId)
      .single();

    if (registrationError || !registration) {
      console.error("Registration lookup failed:", registrationError);
      return response(
        {
          success: false,
          error: "Registration not found",
          details: registrationError?.message ?? null,
        },
        404
      );
    }

    // Only paid registrations get emails
    if (String(registration.payment_status ?? "").toLowerCase() !== "paid") {
      console.error("Registration is not paid:", registration.payment_status);
      return response(
        {
          success: false,
          error: "Registration payment is not marked as paid",
          payment_status: registration.payment_status ?? null,
        },
        400
      );
    }

    // Never send the same confirmation twice
    if (registration.confirmation_email_sent === true) {
      return response({
        success: true,
        already_sent: true,
        registrationId,
      });
    }

    if (!registration.email) {
      return response({ success: false, error: "Registration email is missing" }, 400);
    }

    // ==========================================
    // EVENT DETAILS (from public.forms)
    // ==========================================

    let form: Record<string, unknown> | null = null;

    if (registration.form_name) {
      const { data } = await supabase
        .from("forms")
        .select("form_name, category, event_date, event_time, venue")
        .eq("form_name", registration.form_name)
        .maybeSingle();
      form = data;
    }

    const eventName = escapeHtml(registration.form_name ?? "CareerGyan event");
    const eventCategory = escapeHtml(form?.category ?? "");
    const eventDate = escapeHtml(form?.event_date ?? "");
    const eventTime = escapeHtml(form?.event_time ?? "");
    const eventVenue = escapeHtml(form?.venue ?? "");

    // ==========================================
    // EMAIL DATA
    // ==========================================

    const name = escapeHtml(registration.full_name ?? registration.name ?? "");
    const email = String(registration.email).trim();

    const registrationNumber = escapeHtml(
      registration.registration_number ?? registration.registration_id ?? registration.id
    );

    const phone = escapeHtml(registration.mobile_number ?? "");
    const paymentId = escapeHtml(registration.razorpay_payment_id);
    const orderId = escapeHtml(registration.razorpay_order_id);

    const amount = Number(registration.amount ?? 0);
    const amountInRupees = (amount / 100).toFixed(2);

    const eventRows =
      row("Registered For", `<strong>${eventName}</strong>`) +
      (eventDate ? row("Date", eventDate) : "") +
      (eventTime ? row("Time", eventTime) : "") +
      (eventVenue ? row("Venue", eventVenue) : "");

    /*
     * ---------------------------------------------------------
     * USER EMAIL
     * ---------------------------------------------------------
     */

    const userHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CareerGyan Registration Confirmation</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" style="padding:30px 15px;">
<table width="600" cellpadding="0" cellspacing="0" border="0"
style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr>
<td style="padding:28px;text-align:center;background:#111827;color:#ffffff;">
<h1 style="margin:0;font-size:28px;">CareerGyan</h1>
<p style="margin:8px 0 0;font-size:16px;">Registration Confirmation</p>
</td>
</tr>
<tr>
<td style="padding:30px;">
<h2 style="margin-top:0;">Registration Successful 🎉</h2>
<p>Dear <strong>${name}</strong>,</p>
<p>
Thank you for registering for <strong>${eventName}</strong> with CareerGyan.
Your registration and payment have been successfully received.
</p>
<table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin:20px 0;">
${eventRows}
${row("Registration ID", registrationNumber)}
${row("Email", escapeHtml(email))}
${row("Amount Paid", `₹${amountInRupees}`)}
${row("Payment ID", paymentId)}
${row("Order ID", orderId, true)}
</table>
<p>Your registration has been confirmed successfully. Please keep this email for your records.</p>
<p>Questions? Call +91 96068 68888 or reply to this email.</p>
<p style="margin-top:30px;">Regards,<br><strong>CareerGyan Team</strong></p>
</td>
</tr>
<tr>
<td style="padding:20px;text-align:center;background:#f3f4f6;color:#666;font-size:12px;">
© CareerGyan. All rights reserved.
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;

    console.log("Sending user email to:", email);

    const userResendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        reply_to: REPLY_TO,
        subject: `Registration Confirmed – ${registration.form_name ?? "CareerGyan"}`,
        html: userHtml,
      }),
    });

    const userResendText = await userResendResponse.text();
    let userResendData: Record<string, unknown> = {};
    try {
      userResendData = userResendText ? JSON.parse(userResendText) : {};
    } catch {
      userResendData = { raw: userResendText };
    }

    console.log("User Resend status:", userResendResponse.status);

    if (!userResendResponse.ok) {
      return response(
        {
          success: false,
          error: "User email failed",
          resend_status: userResendResponse.status,
          resend_response: userResendData,
        },
        500
      );
    }

    /*
     * ---------------------------------------------------------
     * ADMIN EMAIL
     * ---------------------------------------------------------
     */

    const adminHtml = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New CareerGyan Registration</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#222;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td align="center" style="padding:30px 15px;">
<table width="600" cellpadding="0" cellspacing="0" border="0"
style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr>
<td style="padding:25px;text-align:center;background:#111827;color:#ffffff;">
<h2 style="margin:0;">New Registration – ${eventName}</h2>
</td>
</tr>
<tr>
<td style="padding:30px;">
<p>A new paid registration has been received.</p>
<table width="100%" cellpadding="8" cellspacing="0" style="border-collapse:collapse;">
${row("Form", `<strong>${eventName}</strong>`)}
${eventCategory ? row("Type", eventCategory) : ""}
${row("Name", name)}
${row("Email", escapeHtml(email))}
${row("Mobile", phone)}
${row("Country", escapeHtml(registration.preferred_country ?? ""))}
${row("Course", escapeHtml(registration.course ?? ""))}
${row("Level", escapeHtml(registration.education_level ?? ""))}
${row("Registration ID", registrationNumber)}
${row("Amount", `₹${amountInRupees}`)}
${row("Payment ID", paymentId)}
${row("Order ID", orderId, true)}
</table>
<p style="margin-top:30px;">This registration has been marked as paid.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
`;

    console.log("Sending admin email to:", ADMIN_EMAIL);

    const adminResendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [ADMIN_EMAIL],
        reply_to: REPLY_TO,
        subject: `New Registration – ${registration.form_name ?? "CareerGyan"} – ${registration.full_name ?? ""}`,
        html: adminHtml,
      }),
    });

    const adminResendText = await adminResendResponse.text();
    let adminResendData: Record<string, unknown> = {};
    try {
      adminResendData = adminResendText ? JSON.parse(adminResendText) : {};
    } catch {
      adminResendData = { raw: adminResendText };
    }

    console.log("Admin Resend status:", adminResendResponse.status);

    if (!adminResendResponse.ok) {
      return response(
        {
          success: false,
          error: "Admin email failed",
          resend_status: adminResendResponse.status,
          resend_response: adminResendData,
        },
        500
      );
    }

    /*
     * ---------------------------------------------------------
     * UPDATE EMAIL STATUS IN DATABASE
     * ---------------------------------------------------------
     */

    const { error: updateError } = await supabase
      .from("registrations")
      .update({
        confirmation_email_sent: true,
        admin_email_sent: true,
      })
      .eq("id", registrationId);

    if (updateError) {
      console.error("Email sent but database update failed:", updateError);
      return response(
        {
          success: true,
          warning:
            "Emails were accepted by Resend, but email status could not be updated in the database.",
          user_email_sent: true,
          admin_email_sent: true,
          database_update_error: updateError.message,
        },
        200
      );
    }

    return response(
      {
        success: true,
        user_email_sent: true,
        admin_email_sent: true,
        confirmation_email_sent: true,
        registrationId,
        user_resend_id: userResendData.id ?? null,
        admin_resend_id: adminResendData.id ?? null,
      },
      200
    );
  } catch (error) {
    console.error("send-confirmation-email error:", error);
    return response(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unexpected server error",
      },
      500
    );
  }
});
