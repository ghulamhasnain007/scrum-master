import type { TaskStore } from '../../../services/tasks/TaskStore.js';
import type { AmbientFunctionCall, AmbientFunctionDeclaration } from '../../../services/GeminiAmbientService.js';

/** The tools registered with Gemini once task actions are enabled — passed
 *  into GeminiAmbientService via DiscordAmbientRoom's functionHandling
 *  extension point (see systemPrompt.ts for the matching prompt section). */
export const AMBIENT_TASK_TOOLS: AmbientFunctionDeclaration[] = [
  {
    name: 'create_task',
    description: 'Create a new task. Only call this when explicitly asked to create/add a task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Short task title' },
        description: { type: 'STRING', description: 'Optional additional detail' },
        assignee: { type: 'STRING', description: 'Optional — who the task is for, by name' },
      },
      required: ['title'],
    },
  },
  {
    name: 'close_task',
    description: 'Mark a task as closed/done. Only call this when explicitly asked to close/complete a task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        taskIdOrTitle: { type: 'STRING', description: "The task's id, or its title (or a close match to it)" },
      },
      required: ['taskIdOrTitle'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List current tasks. Only call this when explicitly asked what tasks are open or closed.',
    parameters: {
      type: 'OBJECT',
      properties: {
        status: { type: 'STRING', enum: ['open', 'closed'], description: 'Optional filter' },
      },
      required: [],
    },
  },
];

/**
 * Resolves a Gemini function call against the built-in TaskStore. Returned
 * object becomes the function response sent back to Gemini — kept as plain
 * JSON-serializable data so the model can reference it in its spoken
 * confirmation (e.g. "created task: fix the login bug").
 */
export async function handleAmbientFunctionCall(
  store: TaskStore,
  orgId: string,
  channelId: string,
  createdBy: string,
  call: AmbientFunctionCall
): Promise<Record<string, unknown>> {
  switch (call.name) {
    case 'create_task': {
      const title = String(call.args.title ?? '').trim();
      if (!title) return { success: false, reason: 'title is required' };
      const task = await store.create(orgId, {
        title,
        description: call.args.description ? String(call.args.description) : undefined,
        assignee: call.args.assignee ? String(call.args.assignee) : undefined,
        createdBy,
        sourceChannelId: channelId,
      });
      return { success: true, task };
    }

    case 'close_task': {
      const idOrTitle = String(call.args.taskIdOrTitle ?? '').trim();
      if (!idOrTitle) return { success: false, reason: 'taskIdOrTitle is required' };
      const task = await store.close(orgId, idOrTitle);
      return task ? { success: true, task } : { success: false, reason: 'no matching open task found' };
    }

    case 'list_tasks': {
      const status = call.args.status === 'open' || call.args.status === 'closed' ? call.args.status : undefined;
      const tasks = await store.list(orgId, status);
      return { success: true, tasks };
    }

    default:
      return { success: false, reason: `unknown function ${call.name}` };
  }
}
