// ==========================================================================
// Φιλαρμονική Ορχήστρα Θήβας — Supabase Edge Function: push-sender
// ==========================================================================
// HOW TO DEPLOY THIS FUNCTION (SUPER EASY — NO COMMAND LINE NEEDED!):
//
// 1. Go to your Supabase Dashboard → Edge Functions
// 2. Click "Create new function"
// 3. Name: push-sender   (all lowercase, no spaces)
// 4. Click "Create"
// 5. In the new panel, click on "Edit in code editor" (or paste from below)
// 6. PASTE the ENTIRE CONTENTS OF THIS FILE into the code editor
// 7. Click "Deploy" (top right)
// 8. Wait ~20-30 seconds for deployment to finish.
// 9. Click on "URL" to copy it to clipboard. Looks like:
//    https://xxxx.supabase.co/functions/v1/push-sender
// 10. Paste that URL into index.html at PUSH_EDGE_FUNCTION_URL (line ~120)
// ==========================================================================
// Then, set the SECRETS (critical — one-time setup):
//
// Edge Functions page → click your `push-sender` function → Secrets tab →
// Add the following 3 secrets (click "Add new secret"):
//
//   NAME:  VAPID_PUBLIC_KEY     VALUE: your public key from generate_vapid_keys.js
//   NAME:  VAPID_PRIVATE_KEY    VALUE: your private key
//   NAME:  VAPID_SUBJECT        VALUE: mailto:your-real-email@example.com
//
// Click "Save" for each.
// ==========================================================================

// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import * as base64 from "https://deno.land/std@0.192.0/encoding/base64.ts";
import * as base64url from "https://deno.land/std@0.192.0/encoding/base64url.ts";
import { concat } from "https://deno.land/std@0.192.0/bytes/concat.ts";

serve(async (req) => {
  // ---- Simple CORS so the browser can call this directly ----
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length,Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };

  try {
    // ---- Auth: require a valid Supabase user AND admin role ----
    const authHeader = req.headers.get("Authorization") || "";
    const apiKey = req.headers.get("apikey") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: missing Bearer token" }),
        { status: 401, headers: CORS }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SERVICE_ROLE_KEY") || "";
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: apiKey,
        Authorization: authHeader,
      },
    });

    if (!userRes.ok) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: invalid token" }),
        { status: 401, headers: CORS }
      );
    }
    if (!serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Server missing SERVICE_ROLE_KEY. Add it to the Edge Function secrets." }),
        { status: 500, headers: CORS }
      );
    }

    const user = await userRes.json();
    const userEmail = user.email || "";

    // ---- Load secrets ----
    const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY") || "";
    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") || "";
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(
        JSON.stringify({ error: "Server missing VAPID secrets. Set them in Supabase Edge Functions → Secrets tab." }),
        { status: 500, headers: CORS }
      );
    }

    // ---- Read the announcement payload ----
    const body = await req.json();
    const title   = (body.title || "").toString().trim();
    const message = (body.body  || "").toString().trim();
    const url     = (body.url   || "./index.html#events").toString();

    if (!title || !message) {
      return new Response(
        JSON.stringify({ error: "Missing title or body" }),
        { status: 400, headers: CORS }
      );
    }

    // ---- Verify the caller is ADMIN by fetching their profile ----
    let { data: profiles, error: profErr } = await fetchFromSupabase(
      supabaseUrl, serviceRoleKey,
      `profiles?select=role&id=eq.${user.id}&limit=1`
    );
    if (!profErr && (!profiles || profiles.length === 0) && userEmail) {
      const emailQuery = encodeURIComponent(userEmail);
      ({ data: profiles, error: profErr } = await fetchFromSupabase(
        supabaseUrl, serviceRoleKey,
        `profiles?select=role&email=eq.${emailQuery}&limit=1`
      ));
    }
    if (profErr || !profiles || profiles.length === 0) {
      return new Response(
        JSON.stringify({ error: "Could not verify admin status: " + (profErr || `no profile for ${user.id}`) }),
        { status: 403, headers: CORS }
      );
    }
    const isAdmin = profiles[0].role === "admin";
    if (!isAdmin) {
      return new Response(
        JSON.stringify({ error: "Forbidden: only admins can send announcements" }),
        { status: 403, headers: CORS }
      );
    }

    // ---- Load ALL push subscriptions from the DB ----
    const { data: subs, error: subsErr } = await fetchFromSupabase(
      supabaseUrl, serviceRoleKey,
      `push_subscriptions?select=endpoint,p256dh_key,auth_secret,user_email,id`
    );
    if (subsErr) {
      return new Response(
        JSON.stringify({ error: "Could not load subscriptions: " + subsErr }),
        { status: 500, headers: CORS }
      );
    }

    const subscribers = subs || [];
    if (subscribers.length === 0) {
      return new Response(
        JSON.stringify({ sent: 0, failed: 0, skipped: 0, note: "No push subscriptions in database yet. Musicians must enable notifications first." }),
        { status: 200, headers: CORS }
      );
    }

    // ---- Build the payload object for the browser notification ----
    const payload = JSON.stringify({
      title,
      body: message,
      icon: "https://raw.githubusercontent.com/thivaphilharmonic-maker/thiva-philharmonic-orchestra-app/main/logo.png",
      badge: "https://raw.githubusercontent.com/thivaphilharmonic-maker/thiva-philharmonic-orchestra-app/main/logo.png",
      tag: "thiva-philharmonic-notification",
      data: { url }
    });

    // ---- Send each push individually (parallel 8 at a time) ----
    const CHUNK = 8;
    let sentCount = 0, failCount = 0;
    const failedIds = [];

    for (let i = 0; i < subscribers.length; i += CHUNK) {
      const batch = subscribers.slice(i, i + CHUNK);
      const results = await Promise.all(
        batch.map((sub) =>
          sendOne(sub, payload, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT, supabaseUrl, serviceRoleKey)
        )
      );
      for (const r of results) {
        if (r.ok) sentCount++;
        else {
          failCount++;
          if (r.subId) failedIds.push({ id: r.subId, email: r.email, reason: r.reason });
        }
      }
    }

    // ---- Log the announcement in announcement_log ----
    try {
      await fetchFromSupabase(
        supabaseUrl, serviceRoleKey,
        `announcement_log`,
        "POST",
        {
          sent_by_email: userEmail,
          title,
          body: message,
          target_count: subscribers.length,
          success_count: sentCount,
          failure_count: failCount,
        }
      );
    } catch (e) { /* ignore logging errors */ }

    return new Response(
      JSON.stringify({
        sent: sentCount,
        failed: failCount,
        total: subscribers.length,
        failed_details: failedIds.slice(0, 20),
        note: failCount > 0 ? "Some subscribers failed — often means old/invalidated subscription (they can re-enable)." : "All delivered!"
      }),
      { status: 200, headers: CORS }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Unexpected error: " + (e.message || String(e)) }),
      { status: 500, headers: CORS }
    );
  }
});

// ==========================================================================
// Helpers
// ==========================================================================

async function fetchFromSupabase(supabaseUrl, apiKey, pathAndQuery, method = "GET", jsonBody = null) {
  const init = {
    method,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(jsonBody ? { "Content-Type": "application/json", Prefer: "return=representation" } : {}),
    },
  };
  if (jsonBody) init.body = JSON.stringify(jsonBody);
  const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, init);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg += " " + (await res.text()).slice(0, 200); } catch (_) {}
    return { data: null, error: msg };
  }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  return { data, error: null };
}

// ------------- Web Push delivery (raw ECDH + AES128-GCM) ------------------

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s + pad), c => c.charCodeAt(0));
}

async function hmacSha256(key, input) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, input));
}

async function hkdf(salt, ikm, info, length) {
  const prk = await hmacSha256(salt, ikm);
  let t = new Uint8Array(0);
  let okm = new Uint8Array(0);
  let i = 0;
  while (okm.length < length) {
    i++;
    const input = concat([t, info, new Uint8Array([i])]);
    t = await hmacSha256(prk, input);
    okm = concat([okm, t]);
  }
  return okm.slice(0, length);
}

async function deriveKeyAndNonce(salt, userPublicKey, userAuth, serverPublicKey, sharedSecret) {
  const keyInfo = concat([
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    new Uint8Array([0]), new TextEncoder().encode("P-256"),
    uint32BE(65), userPublicKey,
    uint32BE(65), serverPublicKey
  ]);
  const prk = await hkdf(userAuth, sharedSecret, keyInfo, 32);
  const nonceInfo = concat([new TextEncoder().encode("Content-Encoding: nonce\0")]);
  const nonce = await hkdf(salt, prk, nonceInfo, 12);
  const key   = await hkdf(salt, prk, concat([new TextEncoder().encode("Content-Encoding: aes128gcm\0")]), 16);
  return { key, nonce };
}

function uint32BE(n) {
  const b = new Uint8Array(4);
  b[0] = (n >> 24) & 0xff; b[1] = (n >> 16) & 0xff;
  b[2] = (n >>  8) & 0xff; b[3] = n & 0xff;
  return b;
}

async function encryptPayload(payloadStr, userPubKeyRaw, userAuthRaw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const serverPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const userPubJwk = rawToJwkPublic(userPubKeyRaw);
  const userPub = await crypto.subtle.importKey("jwk", userPubJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: userPub }, serverPair.privateKey, 256));
  const serverPubRaw = await jwkPublicToRaw(await crypto.subtle.exportKey("jwk", serverPair.publicKey));

  const { key, nonce } = await deriveKeyAndNonce(salt, userPubKeyRaw, userAuthRaw, serverPubRaw, sharedSecret);
  const plainText = concat([new TextEncoder().encode(payloadStr), new Uint8Array([0x02])]); // padding delimiter

  const keyImp = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const ctWithTag = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, keyImp, plainText));

  return concat([
    salt,
    new Uint8Array([0x00, 0x00, 0x10, 0x00]), // rs = 4096
    new Uint8Array([65]),                      // klen = uncompressed 65 bytes
    serverPubRaw,
    ctWithTag
  ]);
}

function rawToJwkPublic(raw) {
  // raw = 65 bytes uncompressed prefix 0x04 || x(32) || y(32)
  const x = base64url.encode(raw.slice(1, 33));
  const y = base64url.encode(raw.slice(33, 65));
  return { kty: "EC", crv: "P-256", x, y, ext: true };
}

async function jwkPublicToRaw(jwk) {
  const x = base64url.decode(jwk.x);
  const y = base64url.decode(jwk.y);
  return concat([new Uint8Array([0x04]), new Uint8Array(x), new Uint8Array(y)]);
}

async function generateVapidJwt(audience, vapidPub, vapidPriv, vapidSubject) {
  const header = base64url.encode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const body   = base64url.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapidSubject
  }));
  const signingInput = new TextEncoder().encode(`${header}.${body}`);
  // VAPID private key is 32-byte raw D / or base64url
  let privRaw;
  try { privRaw = b64uToBytes(vapidPriv); } catch { privRaw = Uint8Array.from(base64.decode(vapidPriv)); }
  // Import as JWK using a trick: we need a matching public key — for signing only, derive public from private
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  // Use the crypto.subtle.importKey of the raw D as a private JWK by deriving the public point manually? Too complex.
  // Simpler: use WebCrypto sign with an importable JWK. Since we have the public key as base64url too (uncompressed), split it.
  const pubFull = b64uToBytes(vapidPub);
  const x = base64url.encode(pubFull.slice(pubFull.length === 65 ? 1 : 0, pubFull.length === 65 ? 33 : 32));
  const y = base64url.encode(pubFull.slice(pubFull.length === 65 ? 33 : 32));
  const d = base64url.encode(privRaw);
  const privJwk = { kty: "EC", crv: "P-256", x, y, d, ext: true, key_ops: ["sign"] };
  const key = await crypto.subtle.importKey("jwk", privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput));
  const sigB64 = base64url.encode(sig);
  return `vapid t=${header}.${body}.${sigB64}, k=${vapidPub}`;
}

async function sendOne(sub, payload, vapidPub, vapidPriv, vapidSubject, supabaseUrl, serviceRoleKey) {
  try {
    const endpointURL = new URL(sub.endpoint);
    const audience = `${endpointURL.protocol}//${endpointURL.host}`;
    const userPub = b64uToBytes(sub.p256dh_key);
    const userAuth = b64uToBytes(sub.auth_secret);

    // Try to import keys first (if bad subscription, skip early)
    if (userPub.length < 64) {
      return { ok: false, subId: sub.id, email: sub.user_email, reason: "invalid pub key length" };
    }
    // Ensure userPub is 65 bytes (uncompressed) if it came as 64 bytes
    const userPubFull = userPub.length === 64
      ? concat([new Uint8Array([0x04]), userPub])
      : userPub;

    const bodyEnc = await encryptPayload(payload, userPubFull, userAuth);
    const vapidAuth = await generateVapidJwt(audience, vapidPub, vapidPriv, vapidSubject);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "43200",
        "Urgency": "normal",
        "Authorization": vapidAuth
      },
      body: bodyEnc
    });

    // 404 / 410 = subscription invalid → delete from DB
    if (res.status === 404 || res.status === 410) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/push_subscriptions?id=eq.${sub.id}`, {
          method: "DELETE",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
        });
      } catch (_) { /* ignore */ }
      return { ok: false, subId: sub.id, email: sub.user_email, reason: `HTTP ${res.status} (subscription removed)` };
    }

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, subId: sub.id, email: sub.user_email };
    }
    return { ok: false, subId: sub.id, email: sub.user_email, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, subId: sub.id, email: sub.user_email, reason: e.message || String(e) };
  }
}
