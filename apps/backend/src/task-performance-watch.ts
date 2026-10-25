import type Database from 'better-sqlite3';
/** First verified use establishes a baseline; the watch survives restarts and account switches. */
export function watchFinancialEvidence(db: Database.Database, key: string, profile: string): void {
  if (db.prepare('SELECT 1 FROM task_pnl_watch WHERE account_key=? AND profile_id=?').get(key,profile)) return;
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO task_pnl_source_state
      SELECT 'execution_strategies',json_array(id),json_array(credential_profile_id,status,created_at,stopped_at,config_json,filled_left,filled_right,open_position)
      FROM execution_strategies WHERE credential_profile_id=?`).run(profile);
    db.prepare(`INSERT OR REPLACE INTO task_pnl_source_state
      SELECT 'managed_positions',json_array(strategy_id),json_array(account_id,json_valid(state_json),
        json_extract(CASE WHEN json_valid(state_json) THEN state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase',
          '$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline'))
      FROM managed_positions WHERE account_id=?`).run(profile);
    db.prepare('INSERT OR REPLACE INTO task_pnl_watch VALUES (?,?)').run(key,profile);
  })();
}
