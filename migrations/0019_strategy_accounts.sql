-- Strategies remain attributable after an account is deleted, so these are intentionally
-- snapshot fields rather than foreign keys to credential_metadata.
-- @ensure-column execution_strategies credential_profile_id TEXT
-- @ensure-column execution_strategies credential_profile_label TEXT

UPDATE execution_strategies
SET credential_profile_id = (
      SELECT active_profile_id FROM credential_session WHERE singleton = 1
    ),
    credential_profile_label = (
      SELECT label
      FROM credential_metadata
      WHERE id = (SELECT active_profile_id FROM credential_session WHERE singleton = 1)
    )
WHERE credential_profile_id IS NULL;

CREATE INDEX IF NOT EXISTS execution_strategies_credential_status_idx
  ON execution_strategies(credential_profile_id, status, updated_at);
