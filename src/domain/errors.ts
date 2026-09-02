export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class AuthorizationError extends DomainError {
  public constructor(message = 'คุณไม่มีสิทธิ์ทำรายการนี้') {
    super('FORBIDDEN', message);
    this.name = 'AuthorizationError';
  }
}

export class ValidationError extends DomainError {
  public constructor(message: string) {
    super('VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DomainError {
  public constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends DomainError {
  public constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}
