// The vocabulary of the task core: a task turns inputs into outputs that get consumed, for a goal. Nothing here knows who asked, who runs it or
// where content comes from. Content is any JSON-serialisable value that the core stores and never looks inside.

// What a task is doing: open, or ended as achieved or dropped. An end waiting for approval leaves the task open.
export type Outcome = 'achieved' | 'dropped';
export type TaskState = 'open' | Outcome;
// An end that the policy asked to approve, kept on the task until decideEnd.
export type PendingEnd = { outcome: Outcome; reason: string };
// The task itself; its goal says what result is wanted and when it counts as done.
export type Task = { id: string; goal: string; state: TaskState; pendingEnd: PendingEnd | null; createdAt: number };
// A piece of content added to a task. ref is opaque and unique per task; delivery is the id of the delivery that produced it, for task-to-task.
export type Input = {
  id: string;
  task: string;
  body: unknown;
  ref: string | null;
  delivery: string | null;
  at: number;
};
// A piece of content the task produced and may hand over.
export type Output = { id: string; task: string; body: unknown; at: number };
// Where an output goes: another task, or a named injected sink with an opaque address.
export type Target = { task: string } | { sink: string; to: unknown };
// The states of a delivery: awaiting approval, being sent, delivered, failed (retryable) or rejected.
export type DeliveryState = 'awaiting' | 'sending' | 'delivered' | 'failed' | 'rejected';
// One output handed to one target. key is the idempotency key sent to the sink; body may differ from the output's after an approval edit.
export type Delivery = {
  id: string;
  task: string;
  output: string;
  target: Target;
  body: unknown;
  key: string;
  state: DeliveryState;
  receipt: unknown;
  error: string | null;
  createdAt: number;
};
// A task with everything attached to it.
export type TaskView = Task & { inputs: Input[]; outputs: Output[]; deliveries: Delivery[] };
// One journal record; seq orders all records of all tasks.
export type JournalRecord = { seq: number; task: string; at: number; type: string; data: Record<string, unknown> };
// What a sink does: send a body to an address with an idempotency key; resolves to an opaque receipt or rejects.
export type Sink = { send(to: unknown, body: unknown, key: string): Promise<unknown> };
// The policy's answer to a delivery or an end.
export type Verdict = 'allow' | 'approve' | 'deny';
// The injected, pure policy: whether a delivery or an end goes ahead, needs approval or is refused.
export type Policy = {
  deliver(task: Task, output: Output, target: Target): Verdict;
  end(task: Task, outcome: Outcome, reason: string): Verdict;
};
// An observer's handler, given each journal record in order.
export type Handler = (record: JournalRecord) => void | Promise<void>;
