// One Server-Sent Events stream a test writes to, as `fetch` would hand it to the page.

const enc = new TextEncoder();

export class TestStream {
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;

  constructor() {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#controller = c;
      },
    });
    this.response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  /** One `event: message`, with its `id:` when given. */
  send(event: unknown, id?: string): void {
    this.#controller.enqueue(enc.encode(`event: message\n${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(event)}\n\n`));
  }

  /** A comment line, as a server's keep-alive is. */
  comment(): void {
    this.#controller.enqueue(enc.encode(":\n\n"));
  }

  end(): void {
    this.#controller.close();
  }

  /** What the request's abort does to a real response body. */
  follow(signal: AbortSignal | null | undefined): void {
    signal?.addEventListener("abort", () => {
      try {
        this.#controller.error(new DOMException("The operation was aborted.", "AbortError"));
      } catch {
        // already closed
      }
    });
  }
}
