"use client";

/** The company's skill list on the Curriculum tab (R-150), with a one-click default set. */
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSkills, useLoadDefaultSkills } from "@/lib/queries/academy";

export function SkillsList({ canManage }: { canManage: boolean }) {
  const skills = useSkills();
  const load = useLoadDefaultSkills();
  const list = skills.data ?? [];
  return (
    <Card className="p-5 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif text-xl">Skills tracked</h2>
          <p className="text-xs text-ink-3">Mentors set each apprentice&apos;s level per skill on the apprentice&apos;s page.</p>
        </div>
        {canManage && list.length === 0 && <Button size="sm" variant="primary" loading={load.isPending} onClick={() => load.mutate()}>Load the 9 default skills</Button>}
      </div>
      {list.length === 0
        ? <p className="text-sm text-ink-3">No skills yet.</p>
        : <p className="text-sm text-ink-2">{list.map((s) => s.name).join(" · ")}</p>}
    </Card>
  );
}
