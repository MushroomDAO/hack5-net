import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A successful NEW submission emails the participant a confirmation carrying their edit token (so it
// isn't lost when the success screen is refreshed). Asserts: new submit → exactly one email to the
// participant with a "提交成功" subject; a validation failure → no email; an edit-via-token update →
// no repeat email (confirmation is new-submission only). Tests the secret track (no screenshots),
// gated by a forged admin session; the Resend call is stubbed so nothing is actually sent.

const TID = "tn-confirm-test";
const SUBDOMAIN = "confirm-test";
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
// hv_auth admin session, scoped to TID → passes the secret gate + hasSecretAccess.
async function adminCookie(): Promise<string> {
  const body = b64url(JSON.stringify({ role: "admin", name: "Admin", jid: "admin", tenant: TID, exp: now() + 3600 }));
  return `hv_auth=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}

function stubResend(status = 200) {
  const calls = { n: 0, to: [] as string[], subjects: [] as string[] };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.resend.com")) {
      calls.n += 1;
      try { const b = JSON.parse(String(init?.body ?? "{}")); calls.to.push(...(b.to ?? [])); calls.subjects.push(b.subject ?? ""); } catch { /* ignore */ }
      return new Response(status === 200 ? JSON.stringify({ id: "email-1" }) : "boom", { status });
    }
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
  return calls;
}

async function submit(body: unknown): Promise<Response> {
  return SELF.fetch(`${HOST}/api/submissions`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await adminCookie() },
    body: JSON.stringify(body),
  });
}

const validBody = {
  projectName: "My Secret Project",
  email: "team@example.com",
  demoUrl: "https://demo.example.app",
  demoUser: "judge",
  demoPass: "pass1234",
  readmeMd: "# My Secret Project\nA private-track entry with a long-enough readme.",
  repoUrl: "https://github.com/acme/secret-repo",
};

async function seedSecretTenant(): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, event_time, start_at, end_at, location, mode, access_days, status, created_at, updated_at)
     VALUES (?, ?, 'Confirm Test', 'x', 'o@e.com', 'o@e.com', '', '', null, null, '', 'secret', 7, 'active', ?, ?)`,
  ).bind(TID, SUBDOMAIN, ts, ts).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM submissions");
  await env.DB.exec("DELETE FROM tenants");
  await seedSecretTenant();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submission confirmation email", () => {
  it("emails the participant a '提交成功' confirmation on a new submission", async () => {
    const resend = stubResend(200);
    const res = await submit(validBody);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; editToken: string };
    expect(out.ok).toBe(true);
    expect(out.editToken).toBeTruthy();

    expect(resend.n).toBe(1);
    expect(resend.to).toEqual(["team@example.com"]);
    expect(resend.subjects[0]).toContain("提交成功");
  });

  it("does NOT email when submission validation fails", async () => {
    const resend = stubResend(200);
    const res = await submit({ ...validBody, email: "" }); // missing email → 400
    expect(res.status).toBe(400);
    expect(resend.n).toBe(0);
  });

  it("does NOT re-email on an edit-via-token update (confirmation is new-only)", async () => {
    const first = stubResend(200);
    const created = (await (await submit(validBody)).json()) as { editToken: string };
    expect(first.n).toBe(1);
    vi.unstubAllGlobals();

    const resend = stubResend(200);
    const res = await submit({ ...validBody, projectName: "Renamed", editToken: created.editToken });
    const out = (await res.json()) as { updated?: boolean };
    expect(out.updated).toBe(true);
    expect(resend.n).toBe(0); // update path sends nothing
  });
});
