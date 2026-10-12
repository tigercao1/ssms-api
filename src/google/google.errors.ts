export class GoogleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class GoogleNotConfiguredError extends GoogleError {
  constructor(readonly missing: string[]) {
    super(`Google is not configured; missing ${missing.join(', ')}.`);
  }
}

export class GoogleNotConnectedError extends GoogleError {
  constructor() {
    super('Google Calendar is not connected.');
  }
}

export class GoogleAuthError extends GoogleError {
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    readonly detail: string,
  ) {
    super(
      `Google token request failed (${status ?? 'network error'}): ${code}${detail ? ` - ${detail}` : ''}`,
    );
  }
}

export class GoogleApiError extends GoogleError {
  constructor(
    readonly status: number | undefined,
    readonly reason: string | undefined,
    readonly detail: string,
  ) {
    super(
      `Google Calendar request failed (${status ?? 'network error'}${reason ? `, ${reason}` : ''}): ${detail}`,
    );
  }
}
