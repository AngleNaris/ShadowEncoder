import type { AgentTaskSnapshot } from './agentApi';

export type TaskRunOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: string }
  | { status: 'canceled' };

export type AgentTaskExecutionResult = {
  outputPaths: string[];
  detail: string;
};

export type AgentTaskHandler = (
  task: AgentTaskSnapshot,
) => Promise<TaskRunOutcome<AgentTaskExecutionResult>>;

type AgentTaskFunction = AgentTaskSnapshot['function'];

type HandlerWaiter = {
  resolve: (handler: AgentTaskHandler) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

const handlers = new Map<AgentTaskFunction, AgentTaskHandler>();
const waiters = new Map<AgentTaskFunction, Set<HandlerWaiter>>();

export function registerAgentTaskHandler(
  taskFunction: AgentTaskFunction,
  handler: AgentTaskHandler,
): () => void {
  handlers.set(taskFunction, handler);
  const pending = waiters.get(taskFunction);
  if (pending) {
    waiters.delete(taskFunction);
    for (const waiter of pending) {
      globalThis.clearTimeout(waiter.timeout);
      waiter.resolve(handler);
    }
  }
  return () => {
    if (handlers.get(taskFunction) === handler) handlers.delete(taskFunction);
  };
}

export function waitForAgentTaskHandler(
  taskFunction: AgentTaskFunction,
  timeoutMs = 10_000,
): Promise<AgentTaskHandler> {
  const current = handlers.get(taskFunction);
  if (current) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const pending = waiters.get(taskFunction) ?? new Set<HandlerWaiter>();
    const waiter: HandlerWaiter = {
      resolve,
      timeout: globalThis.setTimeout(() => {
        pending.delete(waiter);
        if (pending.size === 0) waiters.delete(taskFunction);
        reject(new Error(`等待 ${taskFunction} 任务执行器超时`));
      }, timeoutMs),
    };
    pending.add(waiter);
    waiters.set(taskFunction, pending);
  });
}
