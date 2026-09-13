import type { TaskRecord } from "./db";
import type { TaskState } from "./types";

export interface CodexHookProjection {
  state: TaskState;
  progress?: number;
  result: string;
}

const RESULT_BY_STATE: Record<TaskState, string> = {
  started: "本轮已结束（任务仍进行中）",
  progress: "本轮已结束（任务仍进行中）",
  completed: "任务已完成",
  failed: "本轮已结束（任务状态保持失败）",
  canceled: "本轮已结束（任务状态保持取消）",
};

export function codexHookProjection(
  task: Pick<TaskRecord, "state" | "progress"> | null,
): CodexHookProjection {
  const state = task?.state ?? "completed";
  return {
    state,
    ...(state === "progress" && typeof task?.progress === "number"
      ? { progress: task.progress }
      : {}),
    result: RESULT_BY_STATE[state],
  };
}
