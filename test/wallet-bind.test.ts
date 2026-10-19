import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// Phase 1 of the OP check-in escrow: SIWE wallet binding. No chain, no deposit.
// Covers the review gates that freeze this schema: unverified sessions cannot bind,
// a bad signature consumes the nonce, the address unique index returns 409 under
// concurrency, a user rebind cools the old address down for other emails, and an
// operator unbind does not.

const TID = "tn-wallet-test";
const SUBDOMAIN = "wallet-test";
const HOST = `https://${SUBDOMAIN}.hack5.net`;
const APEX = "https://hack5.net";
const EMAIL_A = "a@wallet.test";
const EMAIL_B = "b@wallet.test";
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
async function participantCookie(email: string, verified: boolean): Promise<string> {
  const body = b64url(JSON.stringify({ email, tenant: TID, exp: now() + 3600, verified }));
  return `hv_part=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}
async function userCookie(email: string): Promise<string> {
  const body = b64url(JSON.stringify({ email, exp: now() + 3600 }));
  return `hv_user=${body}.${await hmacHex(env.AUTH_SECRET as string, body)}`;
}

async function seedTenant(): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, event_time, start_at, end_at, location, mode, access_days, status, created_at, updated_at)
     VALUES (?, ?, 'Wallet Test', 'x', 'o@e.com', 'o@e.com', '', '', null, null, '', 'open', 7, 'active', ?, ?)`,
  ).bind(TID, SUBDOMAIN, ts, ts).run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM wallet_nonces");
  await env.DB.exec("DELETE FROM wallet_binding_history");
  await env.DB.exec("DELETE FROM wallet_bindings");
  await env.DB.exec("DELETE FROM tenants");
  await seedTenant();
});

function freshAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

async function postJson(url: string, cookie: string, body: unknown): Promise<Response> {
  return SELF.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function nonceFor(cookie: string, address: string, host = HOST): Promise<{ status: number; message: string; body: Record<string, unknown> }> {
  const res = await postJson(`${host}/api/wallet/nonce`, cookie, { address });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, message: String(body.message ?? ""), body };
}

async function bindAccount(cookie: string, account: PrivateKeyAccount, host = HOST): Promise<Response> {
  const nonce = await nonceFor(cookie, account.address, host);
  expect(nonce.status).toBe(200);
  const signature = await account.signMessage({ message: nonce.message });
  return postJson(`${host}/api/wallet/bind`, cookie, { signature });
}

describe("wallet binding", () => {
  it("rejects an unverified participant and omits wallet from /api/tenant/me", async () => {
    const cookie = await participantCookie(EMAIL_A, false);
    const nonce = await postJson(`${HOST}/api/wallet/nonce`, cookie, { address: freshAccount().address });
    expect(nonce.status).toBe(401);
    const bind = await postJson(`${HOST}/api/wallet/bind`, cookie, { signature: "0x" + "ab".repeat(65) });
    expect(bind.status).toBe(401);
    const me = await SELF.fetch(`${HOST}/api/tenant/me`, { headers: { cookie } });
    const body = (await me.json()) as Record<string, unknown>;
    expect(body.verified).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "wallet")).toBe(false);
  });

  it("rejects a signed-in-looking request with no session", async () => {
    const res = await postJson(`${HOST}/api/wallet/nonce`, "", { address: freshAccount().address });
    expect(res.status).toBe(401);
  });

  it("issues a SIWE message for this host and chain 10, without a chain switch", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    const nonce = await nonceFor(cookie, account.address);
    expect(nonce.status).toBe(200);
    expect(nonce.message).toContain(`https://${SUBDOMAIN}.hack5.net wants you to sign in with your Ethereum account:`);
    expect(nonce.message).toContain(account.address);
    expect(nonce.message).toContain(`Bind this wallet to ${EMAIL_A} on hack5.`);
    expect(nonce.message).toContain("Chain ID: 10");
    expect(nonce.message).toContain(`URI: https://${SUBDOMAIN}.hack5.net/mine`);
    expect(nonce.message).not.toContain("wallet_switchEthereumChain");
    expect(nonce.body.chainId).toBe(10);
    expect(nonce.body.domain).toBe(`${SUBDOMAIN}.hack5.net`);
  });

  it("binds on a valid signature and returns the checksum address from /me", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    const res = await bindAccount(cookie, account);
    expect(res.status).toBe(200);
    const done = (await res.json()) as { ok: boolean; wallet: { address: string; chainId: number } };
    expect(done.ok).toBe(true);
    expect(done.wallet.address).toBe(account.address);
    expect(done.wallet.chainId).toBe(10);

    const me = (await (await SELF.fetch(`${HOST}/api/tenant/me`, { headers: { cookie } })).json()) as { wallet: { address: string } };
    expect(me.wallet.address).toBe(account.address);
    const status = (await (await SELF.fetch(`${HOST}/api/wallet`, { headers: { cookie } })).json()) as { wallet: { address: string } };
    expect(status.wallet.address).toBe(account.address);

    const history = await env.DB.prepare("SELECT COUNT(*) AS c FROM wallet_binding_history WHERE email = ?").bind(EMAIL_A).first<{ c: number }>();
    expect(Number(history?.c)).toBe(1);
  });

  it("consumes the nonce when the signature does not match the stored message", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    const nonce = await nonceFor(cookie, account.address);
    expect(nonce.status).toBe(200);
    const signature = await account.signMessage({ message: "not the siwe message" });
    const bad = await postJson(`${HOST}/api/wallet/bind`, cookie, { signature });
    expect(bad.status).toBe(401);
    const left = await env.DB.prepare("SELECT nonce FROM wallet_nonces WHERE email = ?").bind(EMAIL_A).first();
    expect(left).toBeNull();
    const again = await postJson(`${HOST}/api/wallet/bind`, cookie, { signature });
    expect(again.status).toBe(401);
  });

  it("does not reuse a nonce after a successful bind", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    const nonce = await nonceFor(cookie, account.address);
    const signature = await account.signMessage({ message: nonce.message });
    expect((await postJson(`${HOST}/api/wallet/bind`, cookie, { signature })).status).toBe(200);
    expect((await postJson(`${HOST}/api/wallet/bind`, cookie, { signature })).status).toBe(401);
  });

  it("returns 409 when the address is already bound, including two concurrent binds", async () => {
    const account = freshAccount();
    const cookieA = await participantCookie(EMAIL_A, true);
    const cookieB = await participantCookie(EMAIL_B, true);
    expect((await bindAccount(cookieA, account)).status).toBe(200);
    const clash = await bindAccount(cookieB, account);
    expect(clash.status).toBe(409);

    await env.DB.exec("DELETE FROM wallet_nonces");
    await env.DB.exec("DELETE FROM wallet_binding_history");
    await env.DB.exec("DELETE FROM wallet_bindings");
    const [sigA, sigB] = await Promise.all([
      nonceFor(cookieA, account.address).then(async (n) => account.signMessage({ message: n.message })),
      nonceFor(cookieB, account.address).then(async (n) => account.signMessage({ message: n.message })),
    ]);
    const [ra, rb] = await Promise.all([
      postJson(`${HOST}/api/wallet/bind`, cookieA, { signature: sigA }),
      postJson(`${HOST}/api/wallet/bind`, cookieB, { signature: sigB }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
  });

  it("cools a user rebind for 24h, lets the same email bind back, then releases after the window", async () => {
    const cookieA = await participantCookie(EMAIL_A, true);
    const cookieB = await participantCookie(EMAIL_B, true);
    const first = freshAccount();
    const second = freshAccount();
    expect((await bindAccount(cookieA, first)).status).toBe(200);
    expect((await bindAccount(cookieA, second)).status).toBe(200);
    const cooled = await bindAccount(cookieB, first);
    expect(cooled.status).toBe(409);
    expect((await bindAccount(cookieA, first)).status).toBe(200);

    await env.DB.exec("DELETE FROM wallet_nonces");
    await env.DB.exec("DELETE FROM wallet_binding_history");
    await env.DB.exec("DELETE FROM wallet_bindings");
    expect((await bindAccount(cookieA, first)).status).toBe(200);
    expect((await bindAccount(cookieA, second)).status).toBe(200);
    const old = first.address.toLowerCase();
    await env.DB.prepare("UPDATE wallet_binding_history SET unbound_at = ? WHERE address = ? AND unbind_reason = 'rebind'")
      .bind(now() - 24 * 60 * 60 - 5, old)
      .run();
    expect((await bindAccount(cookieB, first)).status).toBe(200);
  });

  it("lets a platform user bind on the apex, and an operator unbind does not start the cooldown", async () => {
    const owner = await userCookie(EMAIL_A);
    const other = await participantCookie(EMAIL_B, true);
    const account = freshAccount();
    const nonce = await nonceFor(owner, account.address, APEX);
    expect(nonce.status).toBe(200);
    expect(nonce.message).toContain("URI: https://hack5.net/settings");
    expect(nonce.body.domain).toBe("hack5.net");
    const signature = await account.signMessage({ message: nonce.message });
    expect((await postJson(`${APEX}/api/wallet/bind`, owner, { signature })).status).toBe(200);

    const stranger = await postJson(`${APEX}/api/platform/admin/wallet/unbind`, other, { email: EMAIL_A });
    expect(stranger.status).toBe(403);
    const op = await userCookie("ops@hack5.test");
    const unbound = await postJson(`${APEX}/api/platform/admin/wallet/unbind`, op, { email: EMAIL_A });
    expect(unbound.status).toBe(200);
    const reason = await env.DB.prepare("SELECT unbind_reason FROM wallet_binding_history WHERE email = ?").bind(EMAIL_A).first<{ unbind_reason: string }>();
    expect(reason?.unbind_reason).toBe("admin");
    expect((await bindAccount(other, account)).status).toBe(200);
  });

  it("throttles a second nonce for 10 seconds and rejects a foreign host", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    expect((await nonceFor(cookie, account.address)).status).toBe(200);
    expect((await nonceFor(cookie, account.address)).status).toBe(429);
    await env.DB.prepare("UPDATE wallet_nonces SET issued_at = ? WHERE email = ?").bind(now() - 11, EMAIL_A).run();
    expect((await nonceFor(cookie, account.address)).status).toBe(200);

    const user = await userCookie(EMAIL_A);
    const foreign = await postJson("https://evil.example/api/wallet/nonce", user, { address: account.address });
    expect(foreign.status).toBe(400);
  });

  it("keeps a single history row when the same address is signed again", async () => {
    const cookie = await participantCookie(EMAIL_A, true);
    const account = freshAccount();
    expect((await bindAccount(cookie, account)).status).toBe(200);
    await env.DB.prepare("UPDATE wallet_nonces SET issued_at = ? WHERE email = ?").bind(0, EMAIL_A).run();
    expect((await bindAccount(cookie, account)).status).toBe(200);
    const history = await env.DB.prepare("SELECT COUNT(*) AS c FROM wallet_binding_history WHERE email = ?").bind(EMAIL_A).first<{ c: number }>();
    expect(Number(history?.c)).toBe(1);
  });
});
