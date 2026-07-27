import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end for CC-79: the "retry / resume a failed build" endpoint (POST /api/tenant/mini/app/retry).
// Runs the real Worker in workerd against a real local D1: it resolves a seeded mini tenant by Host, forges
// a verified-participant session cookie exactly as the Worker signs it (HMAC over AUTH_SECRET — read from the
// runtime env so it matches whatever the Worker actually uses), and stubs the outbound loop calls (/estimate
// /plan /run) so we can assert the billing + state transitions without a live WorkBench.

const TID = "tn-mini-test"; // tenant id === the subdomain-resolved tenant's id
const SUBDOMAIN = "mini-test";
const HOST = `https://${SUBDOMAIN}.hack5.net`;
const now = () => Math.floor(Date.now() / 1000);

const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

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
// Reproduce signParticipant: `${b64url(payload)}.${hmacHex(AUTH_SECRET, body)}`, verified session.
async function verifiedCookie(email: string): Promise<string> {
  const body = b64url(JSON.stringify({ email, tenant: TID, exp: now() + 3600, verified: true }));
  return `hv_part=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}

// Stub the Worker's outbound loop calls. /estimate 404s (retry's affordabilityGate then falls back to the
// hold-only gate); /plan + /run succeed unless planFails. Returns live call counts for assertions.
function stubLoop(opts: { planFails?: boolean } = {}) {
  const calls = { estimate: 0, plan: 0, run: 0 };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? "GET";
    if (url.includes("/estimate")) { calls.estimate += 1; return new Response("no estimate", { status: 404 }); }
    if (url.includes("/plan")) { calls.plan += 1; return opts.planFails ? new Response("boom", { status: 500 }) : jsonRes({ jobId: "job-1" }); }
    if (url.includes("/run")) { calls.run += 1; return jsonRes({ accepted: true, jobId: "job-1", queuePos: 1 }); }
    throw new Error(`unexpected outbound fetch in test: ${method} ${url}`);
  });
  return calls;
}

async function retry(id: string, email?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (email) headers["cookie"] = await verifiedCookie(email);
  return SELF.fetch(`${HOST}/api/tenant/mini/app/retry`, { method: "POST", headers, body: JSON.stringify({ id }) });
}

async function seedFailedBuild(opts: { project: string; email: string; balance?: number; buildState?: string }): Promise<string> {
  const { project, email, balance = 100, buildState = "failed" } = opts;
  const id = `sub-${project}`;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO submissions
       (id, tenant_id, project_name, team_name, repo_owner, repo_name, repo_url, video_url,
        share_token, edit_token, email, description, wb_client, wb_project, build_state, build_error, created_at, updated_at)
     VALUES (?, ?, 'flight-guard', 'Team', 'mini', 'repo', 'https://github.com/clestons/flight-guard.git', '',
        ?, 'edit', ?, 'an idea', ?, ?, ?, 'coding T3 failed', ?, ?)`,
  )
    .bind(id, TID, `share-${project}`, email, TID, project, buildState, ts, ts)
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO participant_credits (email, credits, granted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(email, balance, balance, ts, ts)
    .run();
  return id;
}

const balanceOf = (email: string) =>
  env.DB.prepare("SELECT credits FROM participant_credits WHERE email = ?").bind(email).first<{ credits: number }>();
const holdRow = (project: string) =>
  env.DB.prepare("SELECT status, credits FROM credit_ledger WHERE id = ?").bind(`hold:${TID}/${project}`).first<{ status: string; credits: number }>();
const buildStateOf = (id: string) =>
  env.DB.prepare("SELECT build_state, build_error FROM submissions WHERE id = ?").bind(id).first<{ build_state: string; build_error: string | null }>();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // A resolvable, active mini tenant whose id === TID (subdomain → resolveTenant → tid).
  const ts = now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO tenants (id, subdomain, name, admin_pass_hash, mode, status, created_at, updated_at)
     VALUES (?, ?, 'Mini Test', 'x', 'mini', 'active', ?, ?)`,
  )
    .bind(TID, SUBDOMAIN, ts, ts)
    .run();
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM credit_ledger");
  await env.DB.exec("DELETE FROM participant_credits");
  await env.DB.exec("DELETE FROM submissions");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("miniAppRetry — resume a failed build", () => {
  it("failed build + verified owner → re-triggers loop, reserves a fresh hold, flips back to queued", async () => {
    const email = "owner@example.com";
    await seedFailedBuild({ project: "idea-9mt7", email, balance: 100 });
    const calls = stubLoop();

    const res = await retry("sub-idea-9mt7", email);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, jobId: "job-1" });

    // Loop was actually re-driven (resume = re-POST /plan same projectSlug, then /run).
    expect(calls.plan).toBe(1);
    expect(calls.run).toBe(1);

    // Build is back in progress, prior failure reason cleared.
    const s = await buildStateOf("sub-idea-9mt7");
    expect(s?.build_state).toBe("queued");
    expect(s?.build_error).toBeNull();

    // Fresh hold reserved + balance deducted (settles to real cost on the deployed callback; #104 fail-safe).
    expect(await holdRow("idea-9mt7")).toMatchObject({ status: "reserved", credits: 30 });
    expect((await balanceOf(email))?.credits).toBe(70);
  });

  it("a non-failed build is not resumable (no double-run) → 409, no charge", async () => {
    const email = "owner@example.com";
    await seedFailedBuild({ project: "idea-live", email, balance: 100, buildState: "deployed" });
    stubLoop(); // no loop call should happen

    const res = await retry("sub-idea-live", email);
    expect(res.status).toBe(409);
    expect((await balanceOf(email))?.credits).toBe(100); // untouched
    expect(await holdRow("idea-live")).toBeNull();
  });

  it("re-plan fails → hold released (full refund), build stays failed — a failed retry never costs credits", async () => {
    const email = "owner@example.com";
    await seedFailedBuild({ project: "idea-boom", email, balance: 100 });
    stubLoop({ planFails: true });

    const res = await retry("sub-idea-boom", email);
    expect(res.status).toBe(502);
    expect(await holdRow("idea-boom")).toMatchObject({ status: "released" });
    expect((await balanceOf(email))?.credits).toBe(100); // 100 → 70 reserve → +30 refund → 100
    expect((await buildStateOf("sub-idea-boom"))?.build_state).toBe("failed"); // unchanged
  });

  it("without a verified session for the project's email → 402, no charge", async () => {
    const email = "owner@example.com";
    await seedFailedBuild({ project: "idea-noauth", email, balance: 100 });
    stubLoop();

    const res = await retry("sub-idea-noauth"); // no cookie
    expect(res.status).toBe(402);
    expect((await balanceOf(email))?.credits).toBe(100);
    expect(await holdRow("idea-noauth")).toBeNull();
  });
});
