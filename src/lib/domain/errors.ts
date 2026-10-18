export class OperationConflictError extends Error {
  readonly status = 409
  constructor() { super('العملية مش في حالة انتظار اعتماد'); this.name = 'OperationConflictError' }
}

export class OperationValidationError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'OperationValidationError' }
}
