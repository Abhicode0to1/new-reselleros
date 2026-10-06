"use client";

/**
 * Skill progress for one apprentice (R-150): a bar and a level per skill, plus the
 * mentor's note. Staff who see the apprentice can edit; the apprentice only reads (RLS
 * refuses their writes anyway).
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { skillLevel } from "@/lib/academy/performance";
import { useSkills, useApprenticeSkills, useSaveSkillLevels, useLoadDefaultSkills } from "@/lib/queries/academy";

const LEVEL_KIND = { Beginner: "muted", Learning: "info", Competent: "warning", Advanced: "success" } as const;

export function SkillsPanel({ apprenticeId, editable, canSetUp }: { apprenticeId: string; editable: boolean; canSetUp: boolean }) {
  const skills = useSkills();
  const levels = useApprenticeSkills(apprenticeId);
  const save = useSaveSkillLevels();
  const loadDefaults = useLoadDefaultSkills();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, { percent: string; note: string }>>({});

  const list = skills.data ?? [];
  const byId = new Map((levels.data ?? []).map((l) => [l.skill_id, l]));

  function startEdit() {
    setDraft(Object.fromEntries(list.map((s) => [s.id, { percent: String(byId.get(s.id)?.percent ?? 0), note: byId.get(s.id)?.mentor_note ?? "" }])));
    setEditing(true);
  }

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-serif text-xl">Skills</h2>
        {editable && list.length > 0 && !editing && <Button size="sm" variant="outline" onClick={startEdit}>Update skills</Button>}
      </div>

      {list.length === 0 ? (
        <div className="text-sm text-ink-3 space-y-2">
          <p>No skill list yet.</p>
          {canSetUp && <Button size="sm" variant="primary" loading={loadDefaults.isPending} onClick={() => loadDefaults.mutate()}>Load the 9 default skills</Button>}
        </div>
      ) : editing ? (
        <form className="space-y-3" onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            apprentice_id: apprenticeId,
            rows: list.map((s) => ({
              skill_id: s.id,
              percent: Math.max(0, Math.min(100, Math.round(Number(draft[s.id]?.percent) || 0))),
              mentor_note: draft[s.id]?.note.trim() || null,
            })),
          }, { onSuccess: () => setEditing(false) });
        }}>
          {list.map((s) => {
            const pct = Math.max(0, Math.min(100, Math.round(Number(draft[s.id]?.percent) || 0)));
            return (
              <div key={s.id} className="grid gap-2 sm:grid-cols-[150px_90px_1fr] items-center">
                <label htmlFor={`sk-${s.id}`} className="text-sm font-semibold text-ink">{s.name} <span className="text-3xs text-ink-3 font-normal">({skillLevel(pct)})</span></label>
                <Input id={`sk-${s.id}`} type="number" min={0} max={100} value={draft[s.id]?.percent ?? "0"}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: { ...d[s.id], percent: e.target.value } }))} aria-label={`${s.name} percent`} />
                <Input value={draft[s.id]?.note ?? ""} placeholder="Note (optional)" aria-label={`${s.name} note`}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.id]: { ...d[s.id], note: e.target.value } }))} />
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={save.isPending}>Save skills</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <ul className="grid gap-3">
          {list.map((s) => {
            const row = byId.get(s.id);
            const pct = row?.percent ?? 0;
            const level = skillLevel(pct);
            return (
              <li key={s.id}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-semibold text-ink">{s.name}</span>
                  <span className="flex items-center gap-2"><span className="tabular-nums text-ink-2">{pct}%</span><Badge kind={LEVEL_KIND[level]} size="sm">{level}</Badge></span>
                </div>
                <div className="h-2 rounded-full bg-paper-2 overflow-hidden mt-1"><div className="h-full bg-indigo" style={{ width: `${pct}%` }} /></div>
                {row?.mentor_note && <p className="text-xs text-ink-3 mt-1">“{row.mentor_note}”</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
