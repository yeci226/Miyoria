// Extension that writes every frame body it receives, as one line each, to the file named by
// `config.record`, and answers `initialize` with one subscription. It never answers anything
// else (tests that use it only look at what the host sent).
import { appendFileSync } from "node:fs";
import process from "node:process";

let buffer = Buffer.alloc(0);
let record = null;
const pendingLines = [];

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function note(line) {
  if (record === null) pendingLines.push(line);
  else appendFileSync(record, `${line}\n`);
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"));
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.subarray(end + 4 + length);
    const msg = JSON.parse(body);
    if (msg.method === "initialize") {
      record = msg.params.config.record;
      for (const line of pendingLines.splice(0)) appendFileSync(record, `${line}\n`);
    }
    note(body);
    if (msg.method === "initialize") {
      send({ id: msg.id, result: { protocol: 2, contributions: { subscriptions: ["*"] } } });
    } else if (msg.method === "shutdown") {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
