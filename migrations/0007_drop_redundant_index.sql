-- Review nit: subdomain is UNIQUE (implicit index already), so this explicit index is redundant.
DROP INDEX IF EXISTS idx_tenants_subdomain;
