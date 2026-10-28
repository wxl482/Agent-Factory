import { useEffect } from 'react';
import { Button } from 'antd';
import type { Task } from '@af/shared';
import { useStore } from '../lib/store';
import { notify } from '../lib/ui';

/** 目标交付待验收 / 完成时，右上角弹出提醒，一键打开交付页（不用自己去翻任务列表） */
export function GoalNotifier() {
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.tasks === prev.tasks || !prev.connected) return;
        for (const t of Object.values(s.tasks)) {
          const old = prev.tasks[t.id];
          if (t.kind !== 'goal' || !old || old.status === t.status) continue;
          if (t.status === 'awaiting_human') show(t, '📦 交付待你验收', '团队做完了，看看成果，满意就验收通过');
          else if (t.status === 'done') show(t, '✅ 目标完成', '交付物已归档，随时可以在交付页查看和下载');
        }
      }),
    [],
  );
  return null;
}

function show(t: Task, head: string, desc: string) {
  const key = `goal-${t.id}`;
  notify?.open({
    key,
    title: head,
    description: (
      <div className="goal-notice">
        <b>{t.title}</b>
        <span>{desc}</span>
      </div>
    ),
    placement: 'topRight',
    duration: 12,
    actions: (
      <Button
        type="primary"
        size="small"
        onClick={() => {
          notify?.destroy(key);
          useStore.setState({ deliveryGoal: t.id });
        }}
      >
        查看交付
      </Button>
    ),
  });
}
