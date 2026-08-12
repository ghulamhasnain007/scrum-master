/**
 * Built-in task storage for the ambient assistant — per your decision to
 * skip external trackers (Taiga/Jira) for now. Follows the exact same
 * pluggable-interface pattern as every other store in this codebase —
 * swapping in a TaigaAdapter later means writing one class against this
 * interface, not a rewrite. See AMBIENT_BOT_ARCHITECTURE_PLAN.md §6.
 */
export interface Task {
  id: string;
  orgId: string;
  title: string;
  description?: string;
  /** Discord display name, freeform for now — no identity resolution against Discord accounts. */
  assignee?: string;
  status: 'open' | 'closed';
  /** Discord display name of whoever asked the bot to create this task. */
  createdBy: string;
  createdAt: number;
  closedAt: number | null;
  /** Which ambient channel's session created this task — useful for audit/debugging. */
  sourceChannelId: string;
}

export type TaskInput = Omit<Task, 'id' | 'orgId' | 'status' | 'createdAt' | 'closedAt'>;

export interface TaskStore {
  create(orgId: string, input: TaskInput): Promise<Task>;
  /** Matches by exact id first, then falls back to a case-insensitive
   *  substring match against open tasks' titles — voice input won't
   *  reliably produce an exact task id, so title matching is the practical
   *  path for "close the login bug task." */
  close(orgId: string, taskIdOrTitle: string): Promise<Task | null>;
  list(orgId: string, status?: 'open' | 'closed'): Promise<Task[]>;
  get(orgId: string, id: string): Promise<Task | null>;
}
