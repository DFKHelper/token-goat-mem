/** A stub OpenAI-compatible embeddings endpoint, served by `node:http` on an ephemeral loopback port. Shared by tests/unit/embeddings.test.ts and tests/embeddings-cli.test.ts rather than duplicated, and a plain module rather than a `.test.ts` one so importing it does not re-register the importing file's tests. A real socket rather than a mocked `fetch`: src/embeddings.ts exists to talk to a network endpoint, so a mock would exercise the mock's idea of the wire format instead of the parser's handling of a real one -- and the ordering, status, and timeout behaviours these tests care about are precisely the ones a mock cannot reproduce. Loopback only; nothing here leaves the machine. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** What the stub endpoint saw, so a test can assert on headers and body rather than only on the reply. */
export interface RecordedRequest {
  readonly authorization: string | undefined;
  readonly body: { model?: unknown; input?: unknown };
}

export interface StubEmbeddingServer {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  /** Resolves once the stub has begun handling a request, i.e. the client's request reached the server and a deadline that fires after this cannot race the request's arrival. */
  readonly requestReceived: Promise<void>;
  /** Resolves when a client socket closes while it still owes an answer, i.e. the client gave up on the request, including before the request was parsed. */
  readonly clientClosed: Promise<void>;
  close(): Promise<void>;
}

export interface StubEmbeddingServerOptions {
  /** HTTP status to answer with. Defaults to 200. */
  readonly status?: number;
  /** Raw body bytes, bypassing the generated response entirely -- for malformed-body cases. */
  readonly rawBody?: string;
  /** Vector for a given input text. Defaults to {@link defaultVector}. */
  readonly embedFor?: (text: string) => number[];
  /** When true, `data` is emitted last-input-first, with each entry still carrying its true `index`. */
  readonly reverseOrder?: boolean;
  /** When true, the request is recorded but never answered, so only the client giving up can end it. */
  readonly hang?: boolean;
  /** Replaces the whole `data` array, for shape-violation cases. Called once per request. */
  readonly dataOverride?: (inputs: readonly string[]) => unknown;
}

/** A deterministic stand-in for a model: same text in, same vector out, different texts far apart. */
export function defaultVector(text: string): number[] {
  const vector = [0, 0, 0, 0];
  for (let i = 0; i < text.length; i += 1) {
    const slot = i % 4;
    vector[slot] = (vector[slot] ?? 0) + text.charCodeAt(i) / 1000;
  }
  return vector;
}

/** Starts a stub embeddings endpoint. The caller owns `close()`. */
export async function startStubEmbeddingServer(options: StubEmbeddingServerOptions = {}): Promise<StubEmbeddingServer> {
  const requests: RecordedRequest[] = [];
  let resolveClientClosed: () => void = () => undefined;
  const clientClosed = new Promise<void>((resolve) => {
    resolveClientClosed = resolve;
  });
  let resolveRequestReceived: () => void = () => undefined;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequestReceived = resolve;
  });
  // Whether a socket still owes the client an answer: true from connect until its latest response finishes, so a keep-alive socket closed idle after a full answer does not count as the client giving up.
  const owesAnswer = new WeakMap<Socket, boolean>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    resolveRequestReceived();
    owesAnswer.set(req.socket, true);
    res.once("finish", () => owesAnswer.set(req.socket, false));
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let parsed: { model?: unknown; input?: unknown } = {};
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown; input?: unknown };
      } catch {
        parsed = {};
      }
      requests.push({ authorization: req.headers.authorization, body: parsed });
      if (options.hang === true) {
        return;
      }

      const respond = (): void => {
        if (options.rawBody !== undefined) {
          res.writeHead(options.status ?? 200, { "content-type": "application/json" });
          res.end(options.rawBody);
          return;
        }
        if ((options.status ?? 200) !== 200) {
          // The error body deliberately echoes the Authorization header back: real gateways do, and that is exactly how an api key ends up in a user-visible error if the client forwards a failing response's body.
          res.writeHead(options.status ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "nope", seen_authorization: req.headers.authorization } }));
          return;
        }
        const inputs = Array.isArray(parsed.input) ? (parsed.input as string[]) : [];
        const data =
          options.dataOverride !== undefined
            ? options.dataOverride(inputs)
            : inputs
                .map((text, index) => ({ object: "embedding", index, embedding: (options.embedFor ?? defaultVector)(text) }))
                .sort((a, b) => (options.reverseOrder === true ? b.index - a.index : a.index - b.index));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data, model: parsed.model }));
      };

      respond();
    });
  });
  // The raw socket, not the response, reports a client that went away: a client that aborts before the request is parsed never reaches the request handler, so a close listener registered there would never exist to fire.
  server.on("connection", (socket: Socket) => {
    owesAnswer.set(socket, true);
    socket.once("close", () => {
      if (owesAnswer.get(socket) === true) {
        resolveClientClosed();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/embeddings`,
    requests,
    requestReceived,
    clientClosed,
    close: () =>
      new Promise<void>((resolve) => {
        // Without this a client socket left open by an aborted request keeps `close()` pending, and the afterEach hook hangs instead of failing.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
