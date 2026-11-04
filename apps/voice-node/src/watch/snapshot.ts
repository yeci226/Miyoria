// One H.264 keyframe -> one JPEG, via ffmpeg. Nothing touches the disk.
import { spawn } from "node:child_process";

export const MAX_JPEG_BYTES = 900_000;
const TIMEOUT_MS = 10_000;

function convert(h264: Buffer, quality: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const args = [
      "-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-frames:v", "1",
      "-vf", "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease",
      "-q:v", String(quality), "-f", "mjpeg", "pipe:1",
    ];
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new Error("aborted")));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("ffmpeg timed out")));
    }, TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      if (err.length < 500) err += d.toString();
    });
    child.stdin.on("error", () => {}); // ffmpeg may close stdin early; the exit code tells the story
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => {
      const jpeg = Buffer.concat(out);
      if (code === 0 && jpeg.length > 0) finish(() => resolve(jpeg));
      else finish(() => reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`)));
    });
    child.stdin.end(h264);
  });
}

/** Converts one complete keyframe to a JPEG of at most 1280 px on the long side and {@link MAX_JPEG_BYTES}. */
export async function keyframeToJpeg(h264: Buffer, signal: AbortSignal): Promise<Buffer> {
  let jpeg = await convert(h264, 3, signal);
  if (jpeg.length > MAX_JPEG_BYTES) jpeg = await convert(h264, 8, signal);
  if (jpeg.length > MAX_JPEG_BYTES) throw new Error(`snapshot too large (${jpeg.length} bytes)`);
  return jpeg;
}
