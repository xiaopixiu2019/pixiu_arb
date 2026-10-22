-- Migration 0019 read the owner from credential_session.active_profile_id, but that row is only
-- written once the app is running, so on upgraded installs the backfill matched nothing and
-- pre-account strategies stayed unowned — every account then displayed and resumed them as its
-- own. Strategies that predate account profiles ran on the original credentials, which onboarding
-- stores under the fixed id 'gate-crossex-default' (DEFAULT_CREDENTIAL_PROFILE), so attribute the
-- remaining unowned rows to that profile while it still exists.
UPDATE execution_strategies
SET credential_profile_id = 'gate-crossex-default',
    credential_profile_label = (SELECT label FROM credential_metadata WHERE id = 'gate-crossex-default')
WHERE credential_profile_id IS NULL
  AND EXISTS (SELECT 1 FROM credential_metadata WHERE id = 'gate-crossex-default');
