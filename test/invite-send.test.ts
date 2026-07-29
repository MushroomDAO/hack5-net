import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/invites/send — email an invite code to a recipient. Asserts the core invariants:
//   * batch auto-assigns a DISTINCT available code per recipient and marks it sent_to;
//   * a code that's already been sent can NEVER be re-emailed to someone else;
//   * a send whose email fails RELEASES the reservation (code stays available to retry).
// Runs the real Worker in workerd against local D1, forging an admin session cookie exactly as the
// Worker signs it, and stubbing the outbound Resend call so no real email leaves.

const TID = "tn-inv-test";
const SUBDOMAIN = "inv-test";
const HOST = `https://${SUBDOMAIN}.hack5.net`;
const now = () => Math.floor(Date.now() / 1000);

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Reproduce signAuth: `${b64url(payload)}.${hmac(AUTH_SECRET, body)}`, role=admin, scoped to TID.
async function adminCookie(): Promise<string> {
  const body = b64url(JSON.stringify({ role: "admin", name: "Admin", jid: "admin", tenant: TID, exp: now() + 3600 }));
  return `hv_auth=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}

// Resend stub: 200 = delivered, 500 = provider failure. Counts calls for assertions.
function stubResend(status = 200) {
  const calls = { n: 0, to: [] as string[] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.resend.com")) {
      calls.n += 1;
      try { calls.to.push(...(JSON.parse(String(init?.body ?? "{}")).to ?? [])); } catch { /* ignore */ }
      return new Response(status === 200 ? JSON.stringify({ id: "email-1" }) : "boom", { status });
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
  return calls;
}

async function send(body: unknown): Promise<Response> {
  return SELF.fetch(`${HOST}/api/invites/send`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await adminCookie() },
    body: JSON.stringify(body),
  });
}

async function seedTenant(): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, event_time, start_at, end_at, location, mode, access_days, status, created_at, updated_at)
     VALUES (?, ?, 'Invite Test', 'x', 'o@e.com', 'o@e.com', '', '', null, null, '', 'open', 7, 'active', ?, ?)`,
  ).bind(TID, SUBDOMAIN, ts, ts).run();
}

async function seedCodes(codes: string[]): Promise<void> {
  const ts = now();
  for (let i = 0; i < codes.length; i += 1) {
    // created_at spaced so ORDER BY created_at ASC is deterministic
    await env.DB.prepare("INSERT INTO invite_codes (code, tenant_id, created_at) VALUES (?, ?, ?)").bind(codes[i], TID, ts + i).run();
  }
}

const codeRow = (code: string) =>
  env.DB.prepare("SELECT sent_to, sent_at, used_by FROM invite_codes WHERE code = ? AND tenant_id = ?")
    .bind(code, TID).first<{ sent_to: string | null; sent_at: number | null; used_by: string | null }>();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM invite_codes");
  await env.DB.exec("DELETE FROM tenants");
  await seedTenant();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/invites/send", () => {
  it("batch auto-assigns a distinct available code per recipient and marks it sent", async () => {
    await seedCodes(["HV-AAAAAA", "HV-BBBBBB", "HV-CCCCCC"]);
    const resend = stubResend(200);

    const res = await send({ emails: ["alice@example.com", "bob@example.com"] });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sent: number; failed: number; results: { email: string; code: string; ok: boolean }[] };

    expect(out.sent).toBe(2);
    expect(out.failed).toBe(0);
    expect(resend.n).toBe(2);
    const assigned = out.results.map((r) => r.code);
    expect(new Set(assigned).size).toBe(2); // two DISTINCT codes

    // Both reserved codes now carry the recipient email; the third stays free.
    for (const r of out.results) {
      const row = await codeRow(r.code);
      expect(row?.sent_to).toBe(r.email);
      expect(row?.sent_at).toBeGreaterThan(0);
    }
    const free = await env.DB.prepare("SELECT COUNT(*) AS c FROM invite_codes WHERE tenant_id = ? AND sent_to IS NULL AND used_by IS NULL").bind(TID).first<{ c: number }>();
    expect(free?.c).toBe(1);
  });

  it("refuses to re-send a code that has already been emailed", async () => {
    await seedCodes(["HV-ONLY01"]);
    stubResend(200);

    const first = await send({ email: "first@example.com", code: "HV-ONLY01" });
    expect(((await first.json()) as { sent: number }).sent).toBe(1);

    // Same code, different recipient → must be rejected, and the original recipient is untouched.
    const second = await send({ email: "second@example.com", code: "HV-ONLY01" });
    const out2 = (await second.json()) as { sent: number; failed: number; results: { ok: boolean }[] };
    expect(out2.sent).toBe(0);
    expect(out2.failed).toBe(1);
    expect(out2.results[0].ok).toBe(false);
    expect((await codeRow("HV-ONLY01"))?.sent_to).toBe("first@example.com");
  });

  it("releases the reservation when the email send fails, so the code is retryable", async () => {
    await seedCodes(["HV-RETRY1"]);
    stubResend(500); // provider error

    const res = await send({ email: "x@example.com", code: "HV-RETRY1" });
    const out = (await res.json()) as { sent: number; failed: number };
    expect(out.sent).toBe(0);
    expect(out.failed).toBe(1);

    // The code must be free again (not stuck marked-sent) so the admin can retry.
    const row = await codeRow("HV-RETRY1");
    expect(row?.sent_to).toBeNull();
    expect(row?.sent_at).toBeNull();
  });

  it("rejects a non-admin (no cookie)", async () => {
    await seedCodes(["HV-XXXXXX"]);
    const res = await SELF.fetch(`${HOST}/api/invites/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    expect(res.status).toBe(403);
  });
});
