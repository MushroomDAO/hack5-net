#!/usr/bin/env bash
# 手工为参赛者账户充值积分 —— 直接改生产 D1(hackvideo-db)的 participant_credits 表。
#
# 【安全门槛】本脚本需要密码才能运行:
#   - 脚本里只存密码的 SHA-256 哈希(下方 EXPECTED_HASH),明文密码不入库。
#   - 真正的密码放在本地、被 gitignore 的 .env.topup 里(TOPUP_PASSWORD=...)。
#   - 运行时脚本自动 source .env.topup;若哈希对不上或没设,直接拒绝运行。
#   → 换句话说:没有正确的 TOPUP_PASSWORD 就无法执行任何充值/查询。
#   这是临时测试用的软门槛;未来接完整账户/积分体系后弃用。
#
# 用法:
#   ./scripts/topup-credits.sh <email>                 # 只查余额(仍需密码)
#   ./scripts/topup-credits.sh someone@x.com 500        # 充 500(会二次确认)
#   ./scripts/topup-credits.sh someone@x.com 500 --yes  # 跳过确认
#   TOPUP_PASSWORD=... ./scripts/topup-credits.sh ...    # 或临时传密码
#
# 积分换算(默认参数):credits = ceil(USD成本 × CREDITS_MARKUP / CREDIT_USD_VALUE) = 成本 × 100
#   $1 ≈ 100 积分;注册赠送 300;一次小构建 ~$0.02 ≈ 3 积分。
set -euo pipefail
cd "$(dirname "$0")/.."

DB="hackvideo-db"
# 密码的 SHA-256(明文不入库)。要改密码:printf '%s' '新密码' | shasum -a 256,把结果替换到这里,
# 并同步更新本地 .env.topup。
EXPECTED_HASH="0d3d572b7de4bde1dd9bf185461f8aeb41103f9b6e07b8353bada8a27f370665"

# 自动加载本地(gitignored)密码文件
if [[ -z "${TOPUP_PASSWORD:-}" && -f .env.topup ]]; then
  # shellcheck disable=SC1091
  set -a; source .env.topup; set +a
fi
if [[ -z "${TOPUP_PASSWORD:-}" ]]; then
  echo "拒绝:未设置 TOPUP_PASSWORD(放到本地 .env.topup 里,或运行时传入)。"; exit 1
fi
GOT_HASH=$(printf '%s' "$TOPUP_PASSWORD" | shasum -a 256 | cut -d' ' -f1)
if [[ "$GOT_HASH" != "$EXPECTED_HASH" ]]; then
  echo "拒绝:TOPUP_PASSWORD 不正确。"; exit 1
fi

EMAIL="${1:-}"; AMOUNT="${2:-}"; FLAG="${3:-}"
if [[ -z "$EMAIL" ]]; then
  echo "用法: $0 <email> [amount] [--yes]"; exit 1
fi
# 单引号转义,防 SQL 注入(email 里的 ' → '')
EMAIL_SQL="${EMAIL//\'/\'\'}"

bal() {
  npx wrangler d1 execute "$DB" --remote --command \
    "SELECT email, credits, granted, updated_at FROM participant_credits WHERE email='$EMAIL_SQL';"
}

# 只查余额
if [[ -z "$AMOUNT" ]]; then
  echo "== $EMAIL 当前余额 =="; bal; exit 0
fi

if ! [[ "$AMOUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "amount 必须是正整数"; exit 1
fi
NOW=$(date +%s)

echo "== 充值前余额 =="; bal

if [[ "$FLAG" != "--yes" ]]; then
  read -r -p "确认给 [$EMAIL] 充 [$AMOUNT] 积分(生产库 $DB)? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "已取消"; exit 1; }
fi

# email 是 PRIMARY KEY → 有则加、无则建。credits(可用余额)+ granted(累计发放,审计用)同步。
npx wrangler d1 execute "$DB" --remote --command \
  "INSERT INTO participant_credits (email, credits, granted, created_at, updated_at)
   VALUES ('$EMAIL_SQL', $AMOUNT, $AMOUNT, $NOW, $NOW)
   ON CONFLICT(email) DO UPDATE SET
     credits    = credits + $AMOUNT,
     granted    = granted + $AMOUNT,
     updated_at = $NOW;"

echo "== 充值后余额 =="; bal
echo "✓ 已给 $EMAIL 充值 $AMOUNT 积分"
