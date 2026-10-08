export class AuthError extends Error {
  constructor(message = 'Twitch login is invalid or expired') {
    super(message);
    this.name = 'AuthError';
  }
}

export class GqlOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`Twitch API changed: ${operation} failed (${detail})`);
    this.name = 'GqlOperationError';
    this.operation = operation;
  }
}

export class NetworkError extends Error {
  constructor(detail: string) {
    super(`Network error: ${detail}`);
    this.name = 'NetworkError';
  }
}
