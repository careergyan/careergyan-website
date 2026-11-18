// create-order (updated 2026-11-18)
// What changed:
//   - the price now comes from the public.forms table (one row per registration form) instead of the
//     REGISTRATION_AMOUNT_PAISE secret, so every form can have its own price (Workshop ₹1,449, Event ₹100, Webinar ₹50…)
//   - the form must exist and be open; optional seat limit (e.g. 20) is checked against paid registrations
//   - form_name is saved on the registration and added to the Razorpay order notes
// Everything else (validation, reCAPTCHA, Razorpay order, registration number, response) works as before.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return response({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    // ==========================================
    // ENVIRONMENT VARIABLES
    // (REGISTRATION_AMOUNT_PAISE is no longer used)
    // ==========================================

    const supabaseUrl = Deno.env.get("SUPABASE_URL");

    const supabaseSecretKeys = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"
    );
    const supabaseSecretKey = supabaseSecretKeys["default"];

    const razorpayKeyId = Deno.env.get("RAZORPAY_KEY_ID");
    const razorpayKeySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
    const recaptchaSecret = Deno.env.get("RECAPTCHA_SECRET_KEY");

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !razorpayKeyId ||
      !razorpayKeySecret ||
      !recaptchaSecret
    ) {
      console.error("Missing environment variables");
      return response(
        { success: false, error: "Server configuration is incomplete." },
        500
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseSecretKey);

    // ==========================================
    // READ FORM DATA
    // ==========================================

    const body = await req.json();

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const phone = String(body.phone || "").trim();
    const country = String(body.country || "").trim();
    const course = String(body.course || "").trim();
    const level = String(body.level || "").trim();
    const formName = String(body.form_name || "").trim();
    const captchaToken = String(body.captchaToken || "").trim();

    // ==========================================
    // VALIDATION
    // ==========================================

    if (!formName) {
      return response(
        { success: false, error: "Please refresh the page and try again." },
        400
      );
    }

    if (!name) {
      return response({ success: false, error: "Full name is required." }, 400);
    }

    if (!email || !email.includes("@")) {
      return response({ success: false, error: "Valid email is required." }, 400);
    }

    if (!phone) {
      return response({ success: false, error: "Mobile number is required." }, 400);
    }

    if (!level) {
      return response(
        { success: false, error: "Please select Masters or Bachelors." },
        400
      );
    }

    if (!captchaToken) {
      return response(
        { success: false, error: "Please complete the CAPTCHA." },
        400
      );
    }

    // ==========================================
    // FIND THE FORM AND ITS PRICE
    // ==========================================

    const { data: form, error: formError } = await supabaseAdmin
      .from("forms")
      .select("form_name, price_paise, seat_limit, is_open")
      .eq("form_name", formName)
      .maybeSingle();

    if (formError) {
      console.error("Form lookup failed:", formError);
      return response(
        { success: false, error: "Something went wrong. Please try again." },
        500
      );
    }

    if (!form) {
      console.error("Unknown form_name:", formName);
      return response(
        { success: false, error: "This registration form is not available." },
        400
      );
    }

    if (!form.is_open) {
      return response(
        { success: false, error: "Registrations for this event are closed." },
        400
      );
    }

    if (form.seat_limit) {
      const { count, error: countError } = await supabaseAdmin
        .from("registrations")
        .select("id", { count: "exact", head: true })
        .eq("form_name", form.form_name)
        .eq("payment_status", "paid");

      if (countError) {
        console.error("Seat count failed:", countError);
        return response(
          { success: false, error: "Something went wrong. Please try again." },
          500
        );
      }

      if ((count ?? 0) >= form.seat_limit) {
        return response(
          { success: false, error: "Sorry, all seats for this event are booked." },
          400
        );
      }
    }

    const amountPaise = Number(form.price_paise);

    if (!amountPaise || amountPaise <= 0) {
      console.error("Invalid price for form:", form.form_name);
      return response(
        { success: false, error: "Server configuration is incomplete." },
        500
      );
    }

    // ==========================================
    // VERIFY GOOGLE RECAPTCHA
    // ==========================================

    const captchaResponse = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: recaptchaSecret,
          response: captchaToken,
        }),
      }
    );

    const captchaResult = await captchaResponse.json();

    if (!captchaResult.success) {
      console.error("CAPTCHA verification failed:", captchaResult["error-codes"]);
      return response(
        { success: false, error: "CAPTCHA verification failed. Please try again." },
        400
      );
    }

    // ==========================================
    // CREATE RAZORPAY ORDER
    // ==========================================

    const receipt = `CG-${Date.now()}`;
    const auth = btoa(`${razorpayKeyId}:${razorpayKeySecret}`);

    const razorpayResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: receipt,
        partial_payment: false,
        notes: {
          form_name: form.form_name,
          name,
          email,
          phone,
          country,
          course,
          level,
        },
      }),
    });

    const razorpayData = await razorpayResponse.json();

    if (!razorpayResponse.ok) {
      console.error("Razorpay error:", razorpayData);
      return response(
        { success: false, error: "Unable to create payment order." },
        502
      );
    }

    // ==========================================
    // CREATE REGISTRATION NUMBER
    // ==========================================

    const registrationNumber = `CG-${new Date().getFullYear()}-${Date.now()
      .toString()
      .slice(-6)}`;

    // ==========================================
    // SAVE REGISTRATION
    // ==========================================

    const { data: registration, error: databaseError } = await supabaseAdmin
      .from("registrations")
      .insert({
        full_name: name,
        email: email,
        mobile_number: phone,
        preferred_country: country || null,
        course: course || null,
        education_level: level,
        form_name: form.form_name,
        registration_number: registrationNumber,
        razorpay_order_id: razorpayData.id,
        payment_status: "pending",
        amount: amountPaise,
        currency: "INR",
      })
      .select("id, registration_number")
      .single();

    if (databaseError) {
      console.error("Database error:", databaseError);
      return response(
        { success: false, error: "Unable to save registration." },
        500
      );
    }

    // ==========================================
    // RETURN DATA TO FRONTEND
    // ==========================================

    return response({
      success: true,
      registrationId: registration.id,
      registrationNumber: registration.registration_number,
      formName: form.form_name,
      razorpay: {
        keyId: razorpayKeyId,
        orderId: razorpayData.id,
        amount: razorpayData.amount,
        currency: razorpayData.currency,
      },
    });
  } catch (error) {
    console.error("create-order error:", error);
    return response(
      { success: false, error: "Something went wrong. Please try again." },
      500
    );
  }
});
