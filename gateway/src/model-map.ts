import { GatewayConfig, GatewayTaskType } from './config';

const VALID_TASKS: GatewayTaskType[] = ['verdict', 'triage', 'review', 'digest', 'scout', 'query'];

/* Central model control: the X-Task-Type header selects a pinned model; anything
   unmapped, unknown, or absent falls back to the configured default. The client's
   requested model is always ignored. */
export function resolveModel(taskTypeHeader: string | undefined, config: GatewayConfig): string {
  const task = taskTypeHeader as GatewayTaskType;
  if (task && VALID_TASKS.includes(task) && config.taskModels[task]) {
    return config.taskModels[task] as string;
  }
  return config.defaultModel;
}
