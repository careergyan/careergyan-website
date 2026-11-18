// verify-payment (updated 2026-11-18)
// What changed:
//   - a registration that is already marked paid is not updated again (safe if the browser calls twice
//     or the webhook got there first)
//   - the response also returns form_name
// The signature check is unchanged. It does not need prices: the amount is fixed on the Razorpay order
// by create-order, and the signature proves the payment belongs to that order.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function generateHmacSHA256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bufferToHex(signature);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    // ==========================================
    // ENVIRONMENT
    // ==========================================

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseSecretKeys = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"
    );
    const supabaseSecretKey = supabaseSecretKeys["default"];
    const razorpayKeySecret = Deno.env.get("RAZORPAY_KEY_SECRET");

    if (!supabaseUrl || !supabaseSecretKey || !razorpayKeySecret) {
      return response(
        { success: false, error: "Server configuration is incomplete." },
        500
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey);

    // ==========================================
    // REQUEST
    // ==========================================

    const body = await req.json();

    const orderId = String(body.razorpay_order_id || "").trim();
    const paymentId = String(body.razorpay_payment_id || "").trim();
    const signature = String(body.razorpay_signature || "").trim();

    if (!orderId || !paymentId || !signature) {
      return response(
        { success: false, error: "Payment information is incomplete." },
        400
      );
    }

    // ==========================================
    // VERIFY SIGNATURE (constant-time comparison)
    // ==========================================

    const expectedSignature = await generateHmacSHA256(
      `${orderId}|${paymentId}`,
      razorpayKeySecret
    );

    const received = new TextEncoder().encode(signature);
    const expected = new TextEncoder().encode(expectedSignature);

    if (received.length !== expected.length) {
      return response({ success: false, error: "Payment verification failed." }, 400);
    }

    let difference = 0;
    for (let i = 0; i < received.length; i++) {
      difference |= received[i] ^ expected[i];
    }

    if (difference !== 0) {
      console.error("Invalid Razorpay signature");
      return response({ success: false, error: "Payment verification failed." }, 400);
    }

    // ==========================================
    // FIND REGISTRATION
    // ==========================================

    const { data: registration, error: findError } = await supabaseAdmin
      .from("registrations")
      .select("*")
      .eq("razorpay_order_id", orderId)
      .single();

    if (findError || !registration) {
      console.error("Registration not found:", findError);
      return response({ success: false, error: "Registration not found." }, 404);
    }

    // Already paid (e.g. the webhook arrived first): nothing to update.
    if (registration.payment_status === "paid") {
      return response({
        success: true,
        registrationId: registration.id,
        registrationNumber: registration.registration_number,
        paymentStatus: registration.payment_status,
        formName: registration.form_name ?? null,
      });
    }

    // ==========================================
    // UPDATE PAYMENT
    // ==========================================

    const { data: updatedRegistration, error: updateError } = await supabaseAdmin
      .from("registrations")
      .update({
        razorpay_payment_id: paymentId,
        razorpay_signature: signature,
        payment_status: "paid",
        payment_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", registration.id)
      .select("id, registration_number, payment_status, form_name")
      .single();

    if (updateError) {
      console.error("Payment update failed:", updateError);
      return response(
        { success: false, error: "Unable to update payment status." },
        500
      );
    }

    // ==========================================
    // SUCCESS
    // ==========================================

    return response({
      success: true,
      registrationId: updatedRegistration.id,
      registrationNumber: updatedRegistration.registration_number,
      paymentStatus: updatedRegistration.payment_status,
      formName: updatedRegistration.form_name ?? null,
    });
  } catch (error) {
    console.error("verify-payment error:", error);
    return response({ success: false, error: "Payment verification failed." }, 500);
  }
});
