import type Database from 'better-sqlite3';

/** Risk pause blocks execution, not public-data recovery. Explicit KEEP/transfer/completion withdraws demand. */
export function ownedQuoteSymbols(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT c.symbol FROM managed_position_claims c
    JOIN managed_positions m ON m.strategy_id=c.strategy_id
    WHERE json_extract(m.state_json,'$.phase') IN ('OPENING','VERIFYING','MONITORING','EXITING','BALANCING','RISK_PAUSED')
      AND COALESCE(json_extract(m.state_json,'$.stopIntent'),'') <> 'KEEP'
    ORDER BY c.symbol LIMIT 100`).all() as Array<{ symbol: string }>;
  return rows.map(row => row.symbol);
}
