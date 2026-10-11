export interface GoogleRuntime {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const GOOGLE_RUNTIME = Symbol('GOOGLE_RUNTIME');

export const defaultGoogleRuntime: GoogleRuntime = {
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
