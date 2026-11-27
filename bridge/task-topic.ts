import type { Topic } from './state.ts';
// The latest of topics by createdAt; of equal times, the one that comes later in the list.
export function latest(topics: Topic[]): Topic | undefined {
  let last: Topic | undefined;
  for (const t of topics) if (!last || t.createdAt >= last.createdAt) last = t;
  return last;
}
// The topic of task id among topics: the latest one that holds it. Several topics hold one task when a later topic adopted the same agent
// session as an earlier one (see Topics.adopt), and the thread that the owner is in now is the latest.
export const topicOfTask = (topics: Topic[], id: string) => latest(topics.filter((t) => t.taskId === id));
