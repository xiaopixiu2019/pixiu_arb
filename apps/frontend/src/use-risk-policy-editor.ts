import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarginPolicy, MarginSnapshot } from '@gate-crossex/shared-types';
import { riskApi } from './risk-api.js';
import { draftPolicy, policyChanges, policyContent, policyDraft, samePolicy, supersededRiskReply, type RiskPolicyDraft } from './risk-policy-draft.js';
import { riskFresh } from './risk-presentation.js';
import { useRiskDraftGuard } from './risk-draft-guard.js';

interface Editor {
  base: MarginPolicy; draft: RiskPolicyDraft; confirmed: MarginPolicy | null; attempted: MarginPolicy | null;
  phase: 'reading' | 'editing' | 'saving' | 'uncertain' | 'read-failed';
}
const newer = (base: MarginPolicy, policy: MarginPolicy) => policy.revision > base.revision || policy.revision === base.revision && !samePolicy(base, policy);

export function useRiskPolicyEditor(snapshot: MarginSnapshot, fresh: boolean, onSaved: (s: MarginSnapshot) => void, zh: boolean) {
  const [editor, setEditor] = useState<Editor | null>(null), [message, setMessage] = useState('');
  const active = useRef(false), pending = useRef(false), latest = useRef(snapshot);
  latest.current = snapshot;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const changes = editor ? policyChanges(editor.base, editor.draft) : [];
  const conflict = !!editor && newer(editor.base, snapshot.policy);
  const busy = editor?.phase === 'reading' || editor?.phase === 'saving';
  const valid = editor ? draftPolicy(editor.draft) : null;
  const ready = !!editor && editor.phase === 'editing' && !conflict && fresh && !!valid && changes.length > 0;
  useRiskDraftGuard(changes.length > 0 || editor?.phase === 'uncertain', busy, zh);
  useEffect(() => {
    if (!fresh || conflict) setEditor(old => old?.confirmed ? { ...old, confirmed: null } : old);
  }, [fresh, conflict]);
  const enter = useEditorRead(snapshot, active, pending, setEditor, setMessage, zh);
  const change = (next: RiskPolicyDraft) => setEditor(old => old && old.phase === 'editing' ? { ...old, draft: next, confirmed: null } : old);
  const discard = () => { if (!pending.current) { setEditor(null); setMessage(''); } };
  const preview = () => { if (ready && valid) { setEditor(old => old ? { ...old, confirmed: structuredClone(valid) } : old); setMessage(''); } };
  const save = useEditorSave(editor, ready, active, pending, latest, setEditor, setMessage, onSaved, zh);
  const reconcile = useEditorReconcile(editor, active, pending, setEditor, setMessage, onSaved, latest, zh);
  return { editor, message, changes, conflict, busy, ready, valid, enter, change, discard, preview, save, reconcile };
}
type Setter = React.Dispatch<React.SetStateAction<Editor | null>>;
type Message = React.Dispatch<React.SetStateAction<string>>;
type Flag = React.RefObject<boolean>;

function useEditorRead(snapshot: MarginSnapshot, active: Flag, pending: Flag, set: Setter, message: Message, zh: boolean) {
  return useCallback(async () => {
    if (pending.current || !snapshot.accountId) return;
    pending.current = true; message('');
    set({ base: snapshot.policy, draft: policyDraft(snapshot.policy), confirmed: null, attempted: null, phase: 'reading' });
    try {
      const next = await riskApi.policy();
      if (!active.current) return;
      if (next.accountId !== snapshot.accountId) throw new Error('account_changed');
      set({ base: next.policy, draft: policyDraft(next.policy), confirmed: null, attempted: null, phase: 'editing' });
    } catch {
      if (active.current) { set(old => old ? { ...old, phase: 'read-failed' } : old); message(zh ? '最新配置读取失败，请重读后再修改。' : 'Latest policy unavailable. Read again before editing.'); }
    } finally { pending.current = false; }
  }, [active, pending, set, snapshot.accountId, snapshot.policy, message, zh]);
}

function useEditorSave(editor: Editor | null, ready: boolean, active: Flag, pending: Flag, latest: React.RefObject<MarginSnapshot>,
  set: Setter, message: Message, onSaved: (s: MarginSnapshot) => void, zh: boolean) {
  return async () => {
    if (!ready || !editor?.confirmed || pending.current) return;
    const target = editor.confirmed, before = latest.current, accountId = before.accountId;
    pending.current = true; set(old => old ? { ...old, attempted: target, phase: 'saving' } : old);
    const authorize = () => {
      if (!active.current || latest.current.accountId !== accountId || !riskFresh(latest.current) || newer(editor.base, latest.current.policy)) throw new Error('margin_policy_conflict');
    };
    try {
      authorize(); const next = await riskApi.save(target, accountId, authorize);
      if (!active.current) return;
      if (next.accountId !== accountId || policyContent(next.policy) !== policyContent(target) || next.policy.revision <= target.revision) throw new Error('unverified_save');
      if (latest.current.policy.revision > next.policy.revision) throw new Error('margin_policy_conflict');
      if (!supersededRiskReply(next, latest.current, before)) onSaved(next);
      set(null); message(zh ? '已保存。进行中的事件仍使用原有效规则。' : 'Saved. Active incidents retain their effective rules.');
    } catch (error) {
      if (!active.current) return;
      set(old => old ? { ...old, phase: 'uncertain' } : old);
      message(error instanceof Error && error.message === 'margin_policy_conflict'
        ? (zh ? '配置版本或账户状态已变化，请核实最新配置；草稿已保留。' : 'Policy version or account state changed. Reconcile the latest policy; draft retained.')
        : (zh ? '保存结果待核实；不会自动重试，请读取最新配置。' : 'Save result is unverified. Read the latest policy; no automatic retry.'));
    } finally { pending.current = false; }
  };
}

function useEditorReconcile(editor: Editor | null, active: Flag, pending: Flag, set: Setter, message: Message,
  onSaved: (s: MarginSnapshot) => void, latest: React.RefObject<MarginSnapshot>, zh: boolean) {
  return async () => {
    if (pending.current || !editor) return;
    const before = latest.current, accountId = before.accountId; pending.current = true;
    set(old => old ? { ...old, phase: 'reading' } : old);
    try {
      const next = await riskApi.snapshot();
      if (!active.current) return;
      if (next.accountId !== accountId || !riskFresh(next)) throw new Error('unverified');
      if (supersededRiskReply(next, latest.current, before)) throw new Error('obsolete_response');
      onSaved(next);
      const matches = editor.attempted && policyContent(next.policy) === policyContent(editor.attempted) && next.policy.revision > editor.base.revision;
      set(matches ? null : { ...editor, confirmed: null, attempted: null, phase: 'editing' });
      message(matches ? (zh ? '已核实最新配置与本次修改一致。' : 'Latest policy verified to match the requested changes.')
        : (zh ? '已读取最新配置；草稿已保留，请比较差异后重新核对。' : 'Latest policy read. Draft retained; compare and review before proceeding.'));
    } catch { if (active.current) { set({ ...editor, phase: 'uncertain' }); message(zh ? '核实失败，结果仍不确定。' : 'Reconciliation failed; outcome remains uncertain.'); } }
    finally { pending.current = false; }
  };
}

export type RiskPolicyEditor = ReturnType<typeof useRiskPolicyEditor>;
