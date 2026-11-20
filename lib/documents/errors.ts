export class DocumentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); this.name = "DocumentError"; }
}
