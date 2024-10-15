export type ErrorCode =
  | "NOT_FOUND"
  | "METHOD_NOT_FOUND"
  | "METHOD_NOT_INVOCABLE";
export class ActorError extends Error {
  constructor(msg: string, public code: ErrorCode, options?: ErrorOptions) {
    super(msg, options);
  }
}
