import { useEffect, useState } from 'react';
import type { ReferenceQuote } from '@gate-crossex/shared-types';
import { api, ApiError } from './api.js';

const cache = new Map<string, ReferenceQuote>();

/** Page-scoped public reads; no market-watch writes or managed subscription changes. */
export function useReferenceQuotes(symbols: readonly string[], pollMs = 15_000) {
  const key = [...new Set(symbols)].join(',');
  const [entries, setEntries] = useState<ReferenceQuote[]>([]);
  const [checkedAt, setCheckedAt] = useState(Date.now);
  const [loading, setLoading] = useState(false);
  const [completedKey, setCompletedKey] = useState<string | null>(null);
  useEffect(() => {
    const selected = key ? key.split(',') : [];
    // Keep this request complete even when it exceeds the bounded cross-page cache.
    const local = new Map(selected.flatMap((symbol) => { const entry = cache.get(symbol); return entry ? [[symbol, entry] as const] : []; }));
    const controller = new AbortController();
    let cancelled = false;
    let poll: number | undefined;
    const publish = () => {
      if (!cancelled) setEntries([...local.values()]);
    };
    const load = async () => {
      let retryDelay = pollMs;
      setLoading(selected.length > 0);
      publish();
      for (let start = 0; start < selected.length && !cancelled; start += 20) {
        try {
          const result = await api.referenceQuotes(selected.slice(start, start + 20), controller.signal);
          if (cancelled) return;
          for (const entry of result.entries) {
            if (!selected.includes(entry.symbol)) continue;
            local.set(entry.symbol, entry);
            if (cache.size >= 1_000 && !cache.has(entry.symbol)) cache.delete(cache.keys().next().value!);
            cache.set(entry.symbol, entry);
          }
          publish();
        } catch (error) {
          // Quote throttling never delays account/risk reads or trade controls.
          if (error instanceof ApiError && error.status === 429) { retryDelay = Math.max(pollMs, error.retryAfterMs ?? 60_000); break; }
          // Retained quotes expire using their original observation time.
        }
      }
      if (!cancelled) {
        setLoading(false);
        setCompletedKey(key);
        if (selected.length) poll = window.setTimeout(() => { void load(); }, retryDelay);
      }
    };
    void load();
    const clock = selected.length ? window.setInterval(() => setCheckedAt(Date.now()), 1_000) : undefined;
    return () => { cancelled = true; controller.abort(); window.clearInterval(clock); if (poll !== undefined) window.clearTimeout(poll); };
  }, [key, pollMs]);
  return { entries, checkedAt, loading, completedKey, key };
}
