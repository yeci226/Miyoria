// Job records on disk: one JSON file per job in `<output_dir>/jobs/`, written to a temporary file
// and renamed, so a crash leaves the old record or the new one, never half of one. The records
// are few and small (a job is a picture request), so the whole set is read once at start and kept
// in memory; the files are the durable copy.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@miyoria/kernel";
import type { ImageJob } from "@miyoria/types";

const log = getLogger("imagegen.store");
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class JobStore {
  readonly dir: string;
  /** Writes of one job, chained so an older record never lands after a newer one. */
  readonly #writes = new Map<string, Promise<void>>();
  #seq = 0;

  constructor(outputDir: string) {
    this.dir = join(outputDir, "jobs");
  }

  async load(): Promise<ImageJob[]> {
    await mkdir(this.dir, { recursive: true });
    const jobs: ImageJob[] = [];
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
      try {
        const job = JSON.parse(await readFile(join(this.dir, name), "utf8")) as ImageJob;
        if (typeof job.id === "string" && typeof job.state === "string") jobs.push(job);
      } catch (error) {
        log.warn({ file: name, err: error }, "unreadable image job record skipped");
      }
    }
    return jobs;
  }

  /** Writes `job` as it is now (the record is serialized before this returns a promise). */
  save(job: ImageJob): Promise<void> {
    const text = `${JSON.stringify(job, null, 2)}\n`;
    const path = join(this.dir, `${job.id}.json`);
    const tmp = `${path}.${process.pid}.${++this.#seq}.tmp`;
    const write = async () => {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, path);
    };
    const prev = this.#writes.get(job.id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(write);
    this.#writes.set(job.id, next);
    void next
      .finally(() => {
        if (this.#writes.get(job.id) === next) this.#writes.delete(job.id);
      })
      .catch(() => undefined);
    return next;
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}
