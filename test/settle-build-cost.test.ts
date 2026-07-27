import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end regression for CC-76: a `deployed` W5 callback settles the build's up-front credit hold.
// The original bug — settleBuildCost fetched WorkBench /api/usage inside the SAME try as the DB
// settlement, so a live 404 from usage() threw, was swallowed, and left the `reserved` hold stuck
// forever (a `deployed` build is terminal, so the stale-build reaper never sweeps it → the participant's
// 30 credits were trapped). These tests drive the REAL http path: the Worker runs in workerd against a
// real local D1, the inbound callback is HMAC-signed exactly as WorkBench signs it, and the Worker's
// OUTBOUND usage() fetch is stubbed so we can reproduce the 404 and assert credits are freed.

const SECRET = "test-callback-secret"; // must match wrangler.test.jsonc WORKBENCH_CALLBACK_SECRET
const CLIENT = "demo-hackathon";

const now = () => Math.floor(Date.now() / 1000);

// Reproduce wbCallback's signature: hex(HMAC-SHA256(secret, rawBody)), sent as `sha256=<hex>`.
async function sign(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return `sha256=${[...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function postCallback(payload: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(payload);
  return SELF.fetch("https://hack5.net/api/wb/callback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workbench-signature": await sign(raw) },
    body: raw,
  });
}

// Stub the Worker's OUTBOUND global fetch (createWorkbench's http client → GET /api/usage). SELF.fetch,
// which drives the Worker, is a separate Fetcher binding and is unaffected. `handler` decides the reply;
// returns the recorded usage() call count so a test can assert it was / was not called.
function stubUsageFetch(handler: (url: string) => Response | Promise<Response>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (!url.includes("/api/usage")) throw new Error(`unexpected outbound fetch in test: ${init?.method ?? "GET"} ${url}`);
    calls += 1;
    return handler(url);
  });
  return { calls: () => calls };
}

// Seed a submission that reached `reviewing` (non-terminal) plus the participant's balance and, if given,
// the up-front `reserved` hold — the exact state on disk when the terminal `deployed` callback lands.
async function seedBuild(opts: { project: string; email: string | null; hold?: number; balance?: number }): Promise<string> {
  const { project, email, hold, balance = 100 } = opts;
  const id = `sub-${project}`;
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO submissions
       (id, tenant_id, project_name, team_name, repo_owner, repo_name, repo_url, video_url,
        share_token, edit_token, email, wb_client, wb_project, build_state, created_at, updated_at)
     VALUES (?, 'demo', 'P', 'Team', 'o', 'r', 'https://example.com/repo', 'https://example.com/v',
        ?, 'edit', ?, ?, ?, 'reviewing', ?, ?)`,
  )
    .bind(id, `share-${project}`, email, CLIENT, project, ts, ts)
    .run();
  if (email) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO participant_credits (email, credits, granted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(email, balance, balance, ts, ts)
      .run();
  }
  if (hold != null && email) {
    await env.DB.prepare(
      `INSERT INTO credit_ledger (id, tenant_id, email, kind, status, tokens, credits, wb_ref, created_at, updated_at)
       VALUES (?, 'demo', ?, 'build', 'reserved', 0, ?, ?, ?, ?)`,
    )
      .bind(`hold:${CLIENT}/${project}`, email, hold, `${CLIENT}/${project}`, ts, ts)
      .run();
  }
  return id;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const holdRow = (project: string) =>
  env.DB.prepare("SELECT status, credits, tokens FROM credit_ledger WHERE id = ?")
    .bind(`hold:${CLIENT}/${project}`)
    .first<{ status: string; credits: number; tokens: number }>();

const balanceOf = (email: string) =>
  env.DB.prepare("SELECT credits FROM participant_credits WHERE email = ?").bind(email).first<{ credits: number }>();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM credit_ledger");
  await env.DB.exec("DELETE FROM participant_credits");
  await env.DB.exec("DELETE FROM submissions");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settleBuildCost via the deployed W5 callback", () => {
  it("REGRESSION: usage() 404 releases the hold and fully refunds — never traps credits", async () => {
    const email = "trapped@example.com";
    await seedBuild({ project: "proj-404", email, hold: 30, balance: 100 });
    // Reproduce the live workbench.aastar.io/api/usage 404 → the http client throws.
    const usage = stubUsageFetch(() => new Response("Not Found", { status: 404 }));

    const res = await postCallback({ event: "deployed", clientSlug: CLIENT, projectSlug: "proj-404", appUrl: "https://app.example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: "deployed", applied: true });

    expect(usage.calls()).toBe(1);
    expect((await holdRow("proj-404"))?.status).toBe("released"); // BUG BEFORE FIX: stayed 'reserved' forever
    expect((await balanceOf(email))?.credits).toBe(130); // full 30 refunded, not trapped
  });

  it("usage() returns cost → settles the hold to actual and refunds the overheld remainder", async () => {
    const email = "ok@example.com";
    await seedBuild({ project: "proj-ok", email, hold: 30, balance: 100 });
    // costUsd 0.10 → ceil(0.10 * 100) = 10 credits actual; hold was 30 → refund the 20 overheld.
    stubUsageFetch(() => json({ perParticipant: [{ project: "proj-ok", usage: { costUsd: 0.1, inputTokens: 100, outputTokens: 200 } }] }));

    const res = await postCallback({ event: "deployed", clientSlug: CLIENT, projectSlug: "proj-ok" });
    expect(res.status).toBe(200);

    const hold = await holdRow("proj-ok");
    expect(hold?.status).toBe("settled");
    expect(hold?.credits).toBe(10);
    expect(hold?.tokens).toBe(300);
    expect((await balanceOf(email))?.credits).toBe(120); // 100 + 20 refund
  });

  it("no reserved hold → records the cost for accounting without moving the balance", async () => {
    const email = "free@example.com";
    await seedBuild({ project: "proj-free", email, balance: 100 }); // no hold reserved
    stubUsageFetch(() => json({ perParticipant: [{ project: "proj-free", usage: { costUsd: 0.05, inputTokens: 10, outputTokens: 20 } }] }));

    const res = await postCallback({ event: "deployed", clientSlug: CLIENT, projectSlug: "proj-free" });
    expect(res.status).toBe(200);

    const rec = await env.DB.prepare("SELECT status, credits, tokens FROM credit_ledger WHERE id = ?")
      .bind("build:sub-proj-free")
      .first<{ status: string; credits: number; tokens: number }>();
    expect(rec?.status).toBe("recorded");
    expect(rec?.credits).toBe(5);
    expect((await balanceOf(email))?.credits).toBe(100); // unchanged
  });

  it("failed callback releases the hold without ever calling usage()", async () => {
    const email = "failed@example.com";
    await seedBuild({ project: "proj-fail", email, hold: 30, balance: 100 });
    // Any outbound fetch here is a bug — the `failed` path must release the hold directly, no usage() call.
    const usage = stubUsageFetch(() => new Response("Not Found", { status: 404 }));

    const res = await postCallback({ event: "failed", clientSlug: CLIENT, projectSlug: "proj-fail", reason: "boom" });
    expect(res.status).toBe(200);

    expect(usage.calls()).toBe(0);
    expect((await holdRow("proj-fail"))?.status).toBe("released");
    expect((await balanceOf(email))?.credits).toBe(130);
  });
});
