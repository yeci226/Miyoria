// jsdom brings its own `AbortSignal`, but `Request` stays Node's, which refuses a signal from
// another realm: `new Request(url, { signal })` throws. oRPC's link builds a `Request` for every
// call and TanStack Query hands each one a signal, so in tests the signal is left off the
// `Request`. A browser has one realm and needs none of this; no test aborts a request.

const NodeRequest = globalThis.Request;

globalThis.Request = class extends NodeRequest {
  constructor(input: ConstructorParameters<typeof Request>[0], init?: RequestInit) {
    super(input, init?.signal ? { ...init, signal: null } : init);
  }
} as typeof Request;
