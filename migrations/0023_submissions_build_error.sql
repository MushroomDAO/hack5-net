-- Store the build failure reason so a failed mini build can show *why* instead of a bare "构建失败".
-- Populated from the W5 `failed` callback's optional `reason`/`error` field (repo:workbench sends it;
-- receiving side ships here first). NULL until a build actually fails with a reason.
ALTER TABLE submissions ADD COLUMN build_error TEXT;
