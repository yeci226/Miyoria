// What a polled route and its push topic (`push/`) share: a route that has a topic is written as a
// `Watch` (the checks of who may see what, then how the answer is built), and both the route's
// handler and the topic go through that one function. So a topic can never send what the route
// would have refused: the refusal is thrown by the same code, with the same status.

/** One view, for one viewer: checked, named, and ready to be built (again, on every change). */
export interface Watch<T> {
  /**
   * Who sees the same thing: two viewers whose keys are equal get the same value (a public view
   * has one key for everyone, a member's own view has their account in it).
   */
  key: string;
  /** The answer as the polled route would give it now. Throws what the route would throw. */
  build(): T | Promise<T>;
}

/** A view built without waiting (the public views, which a shared cache serves). */
export interface SyncWatch<T> extends Watch<T> {
  build(): T;
}
