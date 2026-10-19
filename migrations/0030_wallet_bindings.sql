-- Platform-level wallet binding for the OP Mainnet check-in deposit.
-- One current address per email, one email per address. History records every
-- bind so a later deposit can be attributed by block time, not by whoever holds
-- the address when the log is reconciled. Addresses are stored lowercase.

CREATE TABLE wallet_bindings (
  email TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL DEFAULT 10,
  bound_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wallet_bindings_address ON wallet_bindings(address);

CREATE TABLE wallet_binding_history (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  bound_at INTEGER NOT NULL,
  unbound_at INTEGER,
  unbind_reason TEXT
);
CREATE INDEX idx_wallet_hist_address ON wallet_binding_history(address, bound_at);

-- One outstanding SIWE message per email. A new request replaces the previous nonce.
CREATE TABLE wallet_nonces (
  email TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  domain TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
