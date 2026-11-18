// Razorpay webhook (updated 2026-11-18) – paste into your existing webhook function (keep its current name).
// What changed:
//   - payment.failed no longer overwrites a registration that is already paid (a student can fail once,
//     retry and pay; a late "failed" event must not undo the payment)
//   - order.paid also checks the amount paid matches the amount saved on the registration, and logs a warning
//     if not (the price now differs per form, so this catches mistakes)
//   - signature comparison is constant-time
// Prices are not needed here: create-order fixes the amount on the Razorpay order.

import { createClient } from "npm:@supabase/supabase-js@2";

function jsonResponse(
  data: Record<string, unknown>,
  status = 200
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
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

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
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
    const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

    if (!supabaseUrl || !supabaseSecretKey || !webhookSecret) {
      console.error("Webhook configuration missing");
      return jsonResponse(
        { success: false, error: "Webhook configuration is incomplete." },
        500
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey);

    // ==========================================
    // RAW BODY + SIGNATURE
    // ==========================================

    const rawBody = await req.text();
    const receivedSignature = req.headers.get("x-razorpay-signature");

    if (!receivedSignature) {
      return jsonResponse({ success: false, error: "Missing webhook signature." }, 400);
    }

    const expectedSignature = await generateHmacSHA256(rawBody, webhookSecret);

    if (!safeEqual(receivedSignature, expectedSignature)) {
      console.error("Invalid Razorpay webhook signature");
      return jsonResponse({ success: false, error: "Invalid webhook signature." }, 400);
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;

    console.log("Razorpay webhook event:", event);

    // ==========================================
    // ORDER PAID
    // ==========================================

    if (event === "order.paid") {
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderEntity = payload?.payload?.order?.entity;

      const orderId = orderEntity?.id || paymentEntity?.order_id;
      const paymentId = paymentEntity?.id;

      if (!orderId) {
        console.error("Order ID missing");
        return jsonResponse({ success: false, error: "Order ID missing." }, 400);
      }

      const { data: registration, error: findError } = await supabaseAdmin
        .from("registrations")
        .select("*")
        .eq("razorpay_order_id", orderId)
        .single();

      if (findError || !registration) {
        // 200 so Razorpay does not keep retrying an order we don't recognise; logged for investigation.
        console.error("Registration not found:", findError);
        return jsonResponse({
          success: true,
          message: "Webhook received but registration was not found.",
        });
      }

      const paidAmount = Number(paymentEntity?.amount ?? orderEntity?.amount_paid ?? 0);
      if (registration.amount && paidAmount && Number(registration.amount) !== paidAmount) {
        console.warn(
          "Amount mismatch for order",
          orderId,
          "form:",
          registration.form_name,
          "expected:",
          registration.amount,
          "paid:",
          paidAmount
        );
      }

      if (registration.payment_status !== "paid") {
        const { error: updateError } = await supabaseAdmin
          .from("registrations")
          .update({
            razorpay_payment_id: paymentId || registration.razorpay_payment_id,
            payment_status: "paid",
            payment_verified_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", registration.id);

        if (updateError) {
          console.error("Database update failed:", updateError);
          return jsonResponse({ success: false, error: "Database update failed." }, 500);
        }
      }

      console.log("Order marked as paid:", orderId, "form:", registration.form_name);
    }

    // ==========================================
    // PAYMENT FAILED (never overwrites a paid registration)
    // ==========================================

    if (event === "payment.failed") {
      const paymentEntity = payload?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;

      if (orderId) {
        await supabaseAdmin
          .from("registrations")
          .update({
            payment_status: "failed",
            updated_at: new Date().toISOString(),
          })
          .eq("razorpay_order_id", orderId)
          .neq("payment_status", "paid");
      }
    }

    return jsonResponse({ success: true, received: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return jsonResponse({ success: false, error: "Webhook processing failed." }, 500);
  }
});
