import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Registration profile + owner-as-admin. The platform session (hv_user) of the event owner
// must count as admin on that event without the per-event password. Open registration stores
// the fixed profile and rejects a missing idea or a track outside the organizer's list.

const TID = "tn-reg-test";
const SUB = "reg-test";
const HOST = `https://${SUB}.hack5.net`;
const OWNER = "owner@reg.test";
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
async function userCookie(email: string): Promise<string> {
  const body = b64url(JSON.stringify({ email, exp: now() + 3600 }));
  return `hv_user=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}

function stubResend() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.resend.com")) return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
}

async function seed(mode = "open", owner = OWNER): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, event_time, start_at, end_at, location, mode, access_days, status, created_at, updated_at)
     VALUES (?, ?, 'Reg Test', 'x', ?, ?, '', '', null, null, '', ?, 7, 'active', ?, ?)`,
  ).bind(TID, mode === "mini" ? "reg-mini" : SUB, owner, owner, mode, ts, ts).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM registrations");
  await env.DB.exec("DELETE FROM email_codes");
  await env.DB.exec("DELETE FROM tenants");
  await seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("owner session skips the admin password", () => {
  it("treats the owning platform login as admin on this event", async () => {
    const res = await SELF.fetch(`${HOST}/api/auth/me`, { headers: { cookie: await userCookie(OWNER) } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; name: string };
    expect(body.role).toBe("admin");
    expect(body.name).toBe("owner");
  });

  it("does not promote a different account", async () => {
    const res = await SELF.fetch(`${HOST}/api/auth/me`, { headers: { cookie: await userCookie("other@reg.test") } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string | null };
    expect(body.role).toBeNull();
  });

  it("reissues the apex login onto the parent domain and returns to the event", async () => {
    const res = await SELF.fetch(
      "https://hack5.net/api/platform/session-bridge?return=" + encodeURIComponent(`${HOST}/judge`),
      { headers: { cookie: await userCookie(OWNER) }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${HOST}/judge?hvbridge=1`);
    const cookies = res.headers.getSetCookie?.() ?? [];
    expect(cookies.some((c) => c.includes("Domain=.hack5.net") && c.includes("hv_user="))).toBe(true);
  });

  it("sends an anonymous visitor back without a session", async () => {
    const res = await SELF.fetch(
      "https://hack5.net/api/platform/session-bridge?return=" + encodeURIComponent(`${HOST}/admin`),
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${HOST}/admin?hvbridge=0`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts a localhost return so local dev does not leave the machine", async () => {
    const ret = "http://127.0.0.1:8787/judge?tenant=testhack1";
    const res = await SELF.fetch(
      "http://127.0.0.1:8787/api/platform/session-bridge?return=" + encodeURIComponent(ret),
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:8787/judge?tenant=testhack1&hvbridge=0");
  });

  it("refuses to bounce the session to another site", async () => {
    const res = await SELF.fetch(
      "https://hack5.net/api/platform/session-bridge?return=" + encodeURIComponent("https://evil.example/steal"),
      { headers: { cookie: await userCookie(OWNER) }, redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://hack5.net/dashboard");
  });
});

describe("POST /api/tenant/register profile", () => {
  it("requires an idea and a track once the organizer defined tracks", async () => {
    stubResend();
    const cookie = await userCookie(OWNER);
    const saved = await SELF.fetch(`${HOST}/api/tenant/registration-form`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tracks: ["DeFi", "公共品"],
        extras: { r1: { label: "住宿", options: ["需要", "不需要"] }, r2: { label: "", options: [] }, i1: "学校或公司", i2: "", t1: "" },
      }),
    });
    expect(saved.status).toBe(200);

    const missing = await SELF.fetch(`${HOST}/api/tenant/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@reg.test", track: "DeFi" }),
    });
    expect(missing.status).toBe(400);

    const badTrack = await SELF.fetch(`${HOST}/api/tenant/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@reg.test", idea: "做一笔公开的清算机器人", track: "Nope" }),
    });
    expect(badTrack.status).toBe(400);

    const ok = await SELF.fetch(`${HOST}/api/tenant/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        nickname: "ada",
        email: "ada@reg.test",
        roles: ["frontend", "contract", "nope"],
        roleOther: "产品",
        github: "https://github.com/ada",
        twitter: "javascript:alert(1)",
        telegram: "@ada",
        idea: "做一笔公开的清算机器人",
        team: "looking",
        track: "DeFi",
        student: "yes",
        gender: "female",
        extras: { r1: "需要", i1: "独立" },
      }),
    });
    expect(ok.status).toBe(400); // javascript: twitter rejected before insert

    const ok2 = await SELF.fetch(`${HOST}/api/tenant/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ada",
        nickname: "ada",
        email: "ada@reg.test",
        roles: ["frontend", "contract", "nope"],
        roleOther: "产品",
        github: "https://github.com/ada",
        telegram: "@ada",
        idea: "做一笔公开的清算机器人",
        team: "looking",
        track: "DeFi",
        student: "yes",
        gender: "female",
        extras: { r1: "需要", i1: "独立" },
      }),
    });
    expect(ok2.status).toBe(200);
    const row = await env.DB.prepare("SELECT nickname, note, profile FROM registrations WHERE email = ?").bind("ada@reg.test").first<{ nickname: string; note: string; profile: string }>();
    expect(row?.nickname).toBe("ada");
    expect(row?.note).toBe("做一笔公开的清算机器人");
    const profile = JSON.parse(row?.profile ?? "{}") as { roles: string[]; track: string; team: string; extras: { r1: string; i1: string } };
    expect(profile.roles).toEqual(["frontend", "contract"]);
    expect(profile.track).toBe("DeFi");
    expect(profile.team).toBe("looking");
    expect(profile.extras.r1).toBe("需要");
    expect(profile.extras.i1).toBe("独立");

    const list = await SELF.fetch(`${HOST}/api/tenant/registrations`, { headers: { cookie } });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { count: number; registrations: { email: string }[] };
    expect(listed.count).toBe(1);
    expect(listed.registrations[0]?.email).toBe("ada@reg.test");

    const anon = await SELF.fetch(`${HOST}/api/tenant/registrations`);
    expect(anon.status).toBe(403);
  });

  it("rejects a choice question with fewer than two options", async () => {
    const res = await SELF.fetch(`${HOST}/api/tenant/registration-form`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await userCookie(OWNER) },
      body: JSON.stringify({ tracks: [], extras: { r1: { label: "住宿", options: ["只要一个"] } } }),
    });
    expect(res.status).toBe(400);
  });

  it("starts an open sign-up as pending and lets the owner approve it", async () => {
    stubResend();
    const cookie = await userCookie(OWNER);
    const res = await SELF.fetch(`${HOST}/api/tenant/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "贝", email: "bei@reg.test", idea: "还在想" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT review_status FROM registrations WHERE email = ?").bind("bei@reg.test").first<{ review_status: string }>();
    expect(row?.review_status).toBe("pending");

    const denied = await SELF.fetch(`${HOST}/api/tenant/registrations/review`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await userCookie("other@reg.test") },
      body: JSON.stringify({ email: "bei@reg.test", status: "approved" }),
    });
    expect(denied.status).toBe(403);

    const bad = await SELF.fetch(`${HOST}/api/tenant/registrations/review`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "bei@reg.test", status: "nope" }),
    });
    expect(bad.status).toBe(400);

    const ok = await SELF.fetch(`${HOST}/api/tenant/registrations/review`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ email: "bei@reg.test", status: "approved" }),
    });
    expect(ok.status).toBe(200);
    const list = await SELF.fetch(`${HOST}/api/tenant/registrations`, { headers: { cookie } });
    const body = (await list.json()) as { registrations: { email: string; review: string }[] };
    expect(body.registrations.find((r) => r.email === "bei@reg.test")?.review).toBe("approved");
  });

  it("approves a mini sign-up immediately", async () => {
    stubResend();
    await env.DB.exec("DELETE FROM tenants");
    await seed("mini");
    const res = await SELF.fetch("https://reg-mini.hack5.net/api/tenant/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "mini@reg.test" }),
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT review_status FROM registrations WHERE email = ?").bind("mini@reg.test").first<{ review_status: string }>();
    expect(row?.review_status).toBe("approved");
  });
});
