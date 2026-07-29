import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Locks the /api/platform/explore invariant: a secret-mode tenant is LISTED (so the plaza is not
// empty when only private events run) but every gated field is redacted to exactly what the
// subdomain gate already discloses for an anonymous visitor — {subdomain, name, mode, phase} only.
// intro / banner / location / works / and the exact start+end timestamps must never leak.

const now = () => Math.floor(Date.now() / 1000);

async function seedTenant(t: {
  subdomain: string;
  name: string;
  mode: "open" | "secret" | "mini";
  intro: string;
  location: string;
  banner: boolean;
  startAt: number;
  endAt: number;
}): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, event_time, start_at, end_at, location, mode, access_days, banner, status, created_at, updated_at)
     VALUES (?, ?, ?, 'x', 'o@e.com', 'o@e.com', ?, '', ?, ?, ?, ?, 7, ?, 'active', ?, ?)`,
  )
    .bind(`ten-${t.subdomain}`, t.subdomain, t.name, t.intro, t.startAt, t.endAt, t.location, t.mode, t.banner ? "1" : null, ts, ts)
    .run();
}

async function seedReadyWork(subdomain: string): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO submissions (id, tenant_id, project_name, team_name, repo_owner, repo_name, repo_url, video_url, share_token, edit_token, status, created_at, updated_at)
     VALUES (?, ?, 'P', 'Team', ?, 'r', 'https://e.com/r', 'https://e.com/v', ?, 'edit', 'ready', ?, ?)`,
  )
    .bind(`sub-${subdomain}`, `ten-${subdomain}`, subdomain, `share-${subdomain}`, ts, ts)
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM submissions");
  await env.DB.exec("DELETE FROM tenants");
});

async function explore(): Promise<any[]> {
  const res = await SELF.fetch("https://hack5.net/api/platform/explore");
  expect(res.status).toBe(200);
  return ((await res.json()) as { hackathons: any[] }).hackathons;
}

describe("platformExplore — secret-mode field redaction", () => {
  it("lists a secret tenant but redacts every gated field, timestamps included", async () => {
    const start = now() - 3600; // in-window → phase 'live'
    const end = now() + 3600;
    await seedTenant({ subdomain: "sh2026", name: "上海2026休闲黑客松", mode: "secret", intro: "TOP SECRET intro", location: "Shanghai HQ", banner: true, startAt: start, endAt: end });
    await seedReadyWork("sh2026"); // a real work exists → prove `works` is still redacted to 0

    const list = await explore();
    const s = list.find((h) => h.subdomain === "sh2026");
    expect(s, "secret tenant must be listed").toBeTruthy();

    // Disclosed (already public at the gate):
    expect(s.name).toBe("上海2026休闲黑客松");
    expect(s.mode).toBe("secret");
    expect(s.phase).toBe("live");

    // Redacted (gated behind an access session):
    expect(s.intro).toBe("");
    expect(s.location).toBe("");
    expect(s.hasBanner).toBe(false);
    expect(s.bannerUrl).toBeNull();
    expect(s.works).toBe(0);
    expect(s.startAt).toBeNull(); // the leak this test guards against
    expect(s.endAt).toBeNull();
  });

  it("keeps non-secret (open) fields intact", async () => {
    const start = now() - 3600;
    const end = now() + 3600;
    await seedTenant({ subdomain: "open1", name: "Open Jam", mode: "open", intro: "public intro", location: "Online", banner: true, startAt: start, endAt: end });
    await seedReadyWork("open1");

    const list = await explore();
    const o = list.find((h) => h.subdomain === "open1");
    expect(o).toBeTruthy();
    expect(o.mode).toBe("open");
    expect(o.intro).toBe("public intro");
    expect(o.location).toBe("Online");
    expect(o.hasBanner).toBe(true);
    expect(o.bannerUrl).toBe("https://open1.hack5.net/banner/open1");
    expect(o.works).toBe(1);
    expect(o.startAt).toBe(start);
    expect(o.endAt).toBe(end);
  });
});
