/**
 * A refusal with the HTTP status it answers with. Its own module, depending on
 * nothing, so a module that `tools.ts` reaches (synology.ts, which extends it
 * at load) or that sits in a cycle with it (plans.ts, plan-edits.ts) never
 * waits on `tools.ts` to finish loading for it.
 */
export class ToolError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ToolError';
    this.status = status;
  }
}
