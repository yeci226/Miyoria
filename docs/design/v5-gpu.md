# GPU arbitration today: the specification hostd must reproduce

> 2026-11-16. Step H7 (a) of [v5-hostd.md](v5-hostd.md) §8 and decision P7: the song worker's GPU
> decisions, written down so that the TypeScript arbiter in hostd can be built without reading the
> Python, and recorded in two checked-in files that the arbiter must reproduce:
> `workers/sing/gpu_decisions.json` (3 172 cases of 18 decision functions) and
> `workers/sing/gpu_scenarios.json` (26 timed scenarios). `workers/tests/test_gpu_table.py`
> rebuilds both from the code on every run and fails when they differ;
> `UPDATE_GPU_TABLE=1` rewrites them. Nothing here changes behaviour. §12 is the move into hostd
> as decided and as built in H7b part 1 (the arbiter, reproducing every row and scenario).
>
> Sources: `workers/sing/gpu.py` (decisions), `exclusive.py` (offload windows), `yielding.py`
> (pausing while she speaks), `server.py` (where a job takes them), `workers/device_memory.py`,
> the `/offload`, `/reload`, `/busy`, `/health` handlers of `workers/asr/server.py` and
> `workers/tts/server.py`, `packages/sing/src/singer.ts` (Core) and
> `packages/workspace/imagegen/src/service.ts` (image generation).

## 1. Actors

| Actor | Holds on the GPU | Role today |
|---|---|---|
| TTS worker (`workers/tts`, 8002) | its model in a child process, about 4.7 GB measured | **evictable**: drops it on `/offload` (kills the child), loads again on `/reload` or when its lease runs out |
| ASR worker (`workers/asr`, 8003) | its model in a child process, about 1.5 GB | **evictable**, same protocol, no drain |
| Song worker (`workers/sing`, 8005) | per stage: the separator, the lead splitter, the voice model; the RVC pass as a subprocess (its VRAM is another process's) | the **only arbiter**: decides, asks the speech workers, renews, reloads |
| Core, `sing` module | nothing | tells the song worker who listens (`POST /gpu/context`) and says go before a window (`POST /jobs/{id}/exclusive`); pauses her speech while a window is on |
| Core, `imagegen` module | nothing; ComfyUI (8188) holds the models | holds its own jobs while a song is prepared or sung and asks ComfyUI to unload (`POST /free`): a **second channel** that does not talk to the song worker |
| OBS, VTube Studio, desktop | some GPU memory | invisible except as less free memory on the device reading |

One song job runs at a time in the worker. Everything below is per job, except three things that
are per machine (`Machine`): the device reading, the learned profile, and `gap_until` (when a
window may open again after her voice came back).

## 2. The life of one job

```
resolve → download → [separate] → [lead] → convert → [convert backing] → mix → beats → lyrics wait → video → done
                      GPU stage    GPU stage GPU stage  GPU stage
```

`separate` runs only when the stems are needed (backing `drop`/`convert`, or no lead split);
`lead` only when the lead split model exists; `convert backing` only for `backing: "convert"`
with a lead. Every GPU stage goes through `_gpu_stage`:

1. **Placement** (`_place`): loop `GpuJob.decide(stage)` (§4) every `SING_GPU_CHECK_S` (1 s)
   while it answers `wait`; the job's `stage` reads `gpu_wait` meanwhile. Then:
   `give_up` → the job fails with the reason; `offload` → open a window (§6) and run on the GPU;
   `share` → run on the GPU;
   `exclusive` (a window is already open) → run on the GPU; `cpu` → run on the CPU. On `share`,
   an `Exclusive` in state `shared` replaces the job's current one unless it is already `shared`.
   The time spent in this loop is "this wait" (`waited_s`); when the loop returns it is added to
   the job's total (`waited_total_s`).
2. **Running**: before every diffusion step or separation segment the stage calls the **gate**:
   cancel check → `torch.cuda.synchronize` → step timing → if speech is busy, **yield** (§7) →
   **tick** (§5) → act on the tick → step timing resumes. CPU stages call the gate too (they yield
   to speech as well); tick does nothing for them. A stage that never stops between steps (her RVC
   model, `SING_VOICE=rvc` or `…+rvc`) never calls the gate: it is not ticked and does not yield;
   instead a thread reads the device every 0.25 s to learn its peak.
3. **Ending**: a stage that finishes records what it measured (peak, step time, rate) and returns.
   A stage stopped by tick (`Suspended`) or by an out-of-memory error on the GPU records its peak,
   unloads every model, **closes the window if one is open** (her voice back, §6), and goes back
   to step 1, resuming where it was (conversion keeps its finished chunks; separation restarts).
4. **After the conversion**: `_give_gpu_back` stops yielding and starts the reload of the speech
   workers (asynchronous: the mix runs meanwhile). The job only counts as done (or failed, or
   cancelled) after the reload has finished: `run_job`'s `finally` waits for it, then calls
   `window_closed`, which is when `gap_until` is set.

A window opened for one stage stays open for the next ones (`separate` then `convert` in one
window, scenario `yield_demucs_separation_takes_a_window_too`); only a suspension or the end of the
job closes it.

## 3. Inputs

### 3.1 Policy

`SING_GPU_POLICY` = `yield` | `auto` | `share` | `offload` | `wait`, case-insensitive, trimmed.
Unset or invalid: the older `SING_GPU_SHARE` decides when set (`"1"` after trimming → `auto`, any
other non-empty value → `offload`); otherwise **`yield`** (the default since 2026-11-09). Read once
when the job's GPU bookkeeping starts (first GPU stage). Table: `policy_from_env`.

### 3.2 Limits (`Limits.from_env`, read at the same moment)

Integers parse with `int()`, floats with `float()`; an unparsable value (including `"1.5"` for an
integer) silently gives the default. Table: `limits_from_env`.

| Field | Variable | Default | Used for |
|---|---|---|---|
| `prior_need_mb` | `SING_SHARE_MIN_FREE_MB` | 4096 | what a stage needs until a run measured it |
| `headroom_pct` | `SING_GPU_HEADROOM_PCT` | 12.0 | share of the card kept free |
| `room_wait_s` | `SING_SHARE_WAIT_S` | 0.0 | `auto`, nobody listening: wait this long before a window |
| `defer_s` | `SING_DEFER_S` | 120.0 | `auto`: wait before a short window; `share`/`offload`: wait after a spill |
| `wait_max_s` | `SING_WAIT_MAX_S` | 600.0 | `auto`: total wait before windows regardless, or failing; `yield`: total wait before failing when her voice cannot help |
| `silence_max_s` | `SING_SILENCE_MAX_S` | 90.0 | a window's length while people listen ("reload included") |
| `silence_gap_s` | `SING_SILENCE_GAP_S` | 60.0 | her voice's time back before the next window |
| `lease_s` | `SING_OFFLOAD_LEASE_S` | 60.0 | `max_s` sent with `/offload` |
| `spill_factor` | `SING_SPILL_FACTOR` | 5.0 | steps this many times slower than normal are a spill |
| `spill_step_s` | `SING_SPILL_STEP_S` | 2.0 | the spill limit while no normal step is known |
| `steps` | `SING_DIFFUSION_STEPS` | 30 | diffusion steps |
| `steps_min` | `SING_DIFFUSION_STEPS_MIN` | 20 | steps left after a spill with nothing else to free |
| `yield_max_s` | `SING_YIELD_MAX_S` | 120.0 | total yielding for an urgent song, or with nobody listening |
| `yield_patient_s` | `SING_YIELD_PATIENT_S` | 900.0 | total yielding otherwise |
| `context_ttl_s` | `SING_CONTEXT_TTL_S` | 20.0 | Core's context is stale after this |
| `check_s` | `SING_GPU_CHECK_S` | 1.0 | the placement loop's period; how often tick reads the card |
| `burst_mb` | `SING_SPEECH_BURST_MB` | 1024 | room left for her voice next to a stage that cannot pause |

Read elsewhere in `server.py`: `SING_OFFLOAD_URLS` (comma list, `/` stripped; who is offloaded),
`SING_YIELD_URLS` (default: the offload list), `SING_EXCLUSIVE_WAIT_S` (30), `SING_RELOAD_TIMEOUT_S`
(300), `SING_YIELD_POLL_MS` (100), `SING_YIELD_HOLD_MS` (300), `SING_CPU_FALLBACK` (comma list of
stages, read once at import; when unset, a real backend whose separator is a Demucs model adds
`separate`; with the default Mel-Band RoFormer separator it stays empty).

### 3.3 Measured and learned (`gather` builds the `Facts`; table `gather`)

| Fact | How it is obtained |
|---|---|
| `cuda` | the backend uses CUDA (`SING_DEVICE`); false → everything on the CPU |
| `on_gpu` | the stage is configured for the GPU (`SING_SEPARATE_DEVICE`, `SING_LEAD_DEVICE` can say `cpu`) |
| `pauses` | false only for the conversion when the voice chain has an RVC pass |
| `total_mb`, `free_mb` | the **whole device** through NVML (`device_memory.read`): other processes included. No NVML on Linux: `torch.cuda.mem_get_info`; on Windows without NVML: unknown (`None`). A read that raises: CUDA with everything unknown |
| `own_mb` | `torch.cuda.memory_reserved` of the song worker: counted as room (`room = free + own`) |
| `need_mb` | `typical_peak` of the stage's last 5 measured peaks, else `prior_need_mb` |
| `headroom_mb` | `max(round(total × headroom_pct / 100), learned)`; Python `round` is half-to-even (table `headroom`) |
| `freed_mb` | learned: free VRAM gained across the last window opening; else the sum of `released_mb` the speech workers report in `/health`; else unknown |
| `speech_loaded` | any offload URL whose `/health` says `offloaded: false`, or does not answer (counts as loaded); read at most every 2 s (timeout 0.5 s), re-read after a window opens or closes (table `speech.read`) |
| `people` | §3.4 |
| `urgent` | §3.4 |
| `waited_s` | this placement loop so far; `waited_total_s` adds the earlier ones of this job |
| `silence_est_s` | `audio_s × (1 − converted) × rate(convert)` (+ `audio_s × rate(stage)` for `separate`/`lead`) `+ reload_s`; rates learned (priors 0.05 / 0.25 / 0.3 s per audio s; a learned 0 counts as unknown), `reload_s` learned (prior 30). No audio length → unknown (table `silence_estimate`) |
| `gap_s` | `max(0, gap_until − now)` |
| `window` | a window is open for this job |
| `offload_useless` | a window was tried and the stage still spilled or ran out of memory in it |
| `cpu_only` | separation or lead spilled once: such stages go to the CPU for the rest of the job |
| `cpu_fallback` | the stage is in `CPU_FALLBACK` |
| `crowded_mb` | room (`free + own`) at the last spill or out-of-memory |

The learned profile is per card (`name/total_mb`) in `<SING_DATA_DIR>/_gpu-profile.json`:
per stage the last five peaks, the normal step time (a clean run's median; it sinks at once and
rises at most 20 % per run), samples and rate; per card the learned headroom (raised by a spill to
`min(free_at_spill + 256, total // 4)`, lowered by a clean run whose lowest free was below it),
`freed_mb`, `reload_s`, the last ten spills. Tables `typical_peak`, `profile.note_step`,
`profile.note_spill`, `profile.note_healthy`.

### 3.4 Audience and urgency (from Core)

Core's `sing` module, on every poll (`poll_ms`, 1500 ms) **while at least one song is preparing**,
sends `POST /gpu/context {in_voice, listeners, live, urgent: [job ids]}`:
`in_voice` = she is in any voice channel; `listeners` = people in those channels; `live` = Go Live
or streaming; `urgent` = jobs of songs that are **forced** (asked by command or the queue: sung as
soon as ready). The worker stores it with the time.

`people` (table `audience.people`):
- never told: `None` (unknown) when the job was submitted with `exclusive_ack` (Core will speak),
  else `False`;
- told longer than `context_ttl_s` ago (strictly more): `None`;
- else `live or (in_voice and listeners > 0)`.

`None` counts as people everywhere it matters: it never lets a job take her voice for want of
listeners, and an open window keeps its limit. `urgent` (table `server.urgent`): this job's id is in
the list, or the id of a job still **queued** behind it.

## 4. Placement: `decide(Facts)` in the order the code tests

`want = need + headroom + burst`, where `burst = burst_mb` only when the stage does not pause and
speech is loaded. `room = free + own` (unknown when `free` is). `fits` = room known, `room ≥ want`,
and, after a spill or OOM, `room ≥ crowded + 0.1 × need`. `separate` = the stage is `separate` or
`lead`. `can` = `speech_loaded and not offload_useless`.

| # | Condition | Outcome (`mode/code`) |
|---|---|---|
| 1 | not `cuda` | `cpu/no_cuda` |
| 2 | not `on_gpu` | `cpu/configured_cpu` |
| 3 | `window` | `exclusive/window` |
| 4 | `cpu_only` | `cpu/spill_cpu` |
| 5 | policy `share`: `crowded` set and `waited_s < defer_s` | `wait/share_spill`, else `share/policy_share` |
| 6 | policy `offload`: not `speech_loaded` | `share/nothing_to_offload` |
| 6b | … `offload_useless and not fits and waited_s < defer_s` | `wait/offload_useless`, else `offload/policy_offload` |
| 7 | `fits` | `share/fits` |
| 8 | policy `wait` | `cpu/policy_wait_cpu` for `separate`/`lead`, else `wait/policy_wait` |
| 9 | room unknown and not `speech_loaded` | `share/unknown_card` |
| 10 | policy `yield`: `cpu_fallback and (not can or gap_s > 0)` | `cpu/no_room_cpu` |
| 10b | … `gap_s > 0 and can` | `wait/gap` |
| 10c | … `can` | `offload/urgent` when urgent, else `offload/no_room` |
| 10d | … otherwise: `waited_total_s ≥ wait_max_s` | `give_up/no_room` (since 2026-11-16), else `wait/no_room` |
| 11 | `auto` from here. `helps` = `can` and (freed unknown or room unknown or `room + freed ≥ want`); `small` = `total < want` | |
| 12 | `people is False and helps and waited_s ≥ room_wait_s` | `offload/nobody_listening` |
| 13 | `separate` and (not urgent or not `can` or `gap_s > 0`) | `cpu/no_room_cpu` |
| 14 | `gap_s > 0 and can` | `wait/gap` |
| 15 | `urgent and can` | `offload/urgent` |
| 16 | `helps` and `silence_est_s ≤ silence_max_s` (known) and `waited_s ≥ defer_s` | `offload/short_silence` |
| 17 | `waited_total_s ≥ wait_max_s`: `can` | `offload/waited_long` |
| 17b | … not `can` and not `small` | `give_up/no_room` |
| 18 | `small and not can` | `share/too_small` |
| 19 | otherwise | `wait/no_room` |

Every outcome also carries a Chinese `reason` that she may say; the table records it verbatim
(numbers formatted with Python's `{:.0f}` and `{:.1f}`, GB as MB/1024). The job's decision history
keeps a new entry only when `mode/code` changes.

## 5. While a stage runs: `tick` (once per step, GPU stages only; table `tick`)

1. **Card reading**: at most every `check_s`; otherwise the last reading. A known reading below
   `headroom / 2` counts a low read (`low_reads + 1`), a known one at or above resets it, an
   unknown one leaves it.
2. **Silence limit** (only with a window open and policy not `offload`): if `people is False`, the
   silence clock is cleared; otherwise it starts now if not running. `work_s = max(silence_max_s −
   reload_s, silence_max_s / 2)` (with the defaults: 60 s, or 45 s once a reload took ≥ 45 s). When
   the clock has run `≥ work_s`: **suspend** `silence_limit`.
3. **Spill test**: `slow` = the last three step times all `≥ limit`, `limit = normal × spill_factor`,
   or `spill_step_s` when no normal step is known. A slow run with no normal step and free unknown
   or `free > headroom` is not a spill (a slow card). `low` = `low_reads ≥ 3` and no window and
   `people is not False`. Neither → nothing (and `spilling` false).
4. **Response**, in order:
   - first time in this stage run: **trim** (`spill_free`): free the worker's cache, count a spill,
     learn the headroom if it was a slow-step spill, clear the step window and low reads;
   - then (window cleared, low reads cleared): a `separate`/`lead` stage → `cpu_only`, **suspend**
     `spill_cpu` (redone on the CPU);
   - with a window open: conversion not yet reduced and `steps_min < steps` → **reduce** to
     `steps_min` (`spill_reduce`, the remaining chunks use fewer steps); else `offload_useless`,
     `crowded = room`, **suspend** `spill_wait`;
   - policy `share`, conversion not yet reduced → **reduce**;
   - policy `auto`/`yield`, speech loaded, not useless, no gap, and (urgent or `people is False`)
     → **offload** `spill_offload` (a window opens between two steps; the stage keeps its memory
     during Core's go and the offload);
   - else `crowded = room`, **suspend** `spill_wait`.

A suspension unloads the stage, closes any window, and returns to placement (§2).

## 6. Windows, leases and recovery (`exclusive.py`)

One `Exclusive` per window. States: `None → waiting → offloading → active → reloading → done`, or
`None → shared` (sharing; nothing offloaded). Core treats `offloading`, `active` and `reloading`
as "speech is off" and pauses her speech.

- **Opening** (`_open_window`): `job.go` is cleared (every window waits for its own go); the job's
  `stage` reads `exclusive`. With `exclusive_ack` (Core sets it when `prepare_notice` is on, the
  default): state `waiting` until Core's `POST /jobs/{id}/exclusive` or `SING_EXCLUSIVE_WAIT_S`
  (30 s), polling every 0.1 s, cancel checked. Then `offloading`: `POST <url>/offload {"reason":
  "sing", "max_s": lease_s}` to each URL **in turn** (timeout 60 s). Any reply without an exception
  counts as offloaded; a failure is logged in `errors` and skipped. Then `active`; `window_opened`
  starts the silence clock (unless `people is False`) and learns `freed_mb` from the change of free
  VRAM since just before the offload (only when positive).
- **Renewal**: while active, a thread re-sends the same `/offload` to every URL that was **asked**
  (also those that failed: they may answer now) every `max_s / 3` (20 s), timeout `min(5, max_s/3)`.
  The speech worker treats each one as a fresh lease of `max_s`. With `lease_s = 0` there is no
  renewal and the workers never come back by themselves.
- **Closing** (`end`, idempotent): renewals stop; state `reloading`; a thread sends `POST
  <url>/reload {}` to every asked URL **in turn** (timeout `SING_RELOAD_TIMEOUT_S`, 300 s); failures
  are logged (the lease, no longer renewed, brings that worker back by itself); then `done`.
  `_close_window` waits for the reload, then `window_closed`: the silence clock stops; **if it was
  running** (people could hear), `gap_until = now + silence_gap_s`; `reload_s` is learned from the
  reload's duration.
- **Holder dies**: nobody renews; each speech worker reloads by itself `max_s` after the last
  renewal (60 s by default, 40 to 60 s after the death). Scenario
  `holder_dies_mid_window_restart_after_lease`.
- **Startup recovery** (`_recover_speech`, a thread at the worker's start): for each offload URL,
  `GET /health` (2 s); if `offloaded` and `reason == "sing"` exactly, `POST /reload` (300 s).
  Errors are logged. Table `server.recover_speech`; scenario
  `holder_dies_mid_window_restart_before_lease`.

## 7. Yielding while she speaks (`yielding.py`)

Created with the job's GPU bookkeeping: polls `GET <url>/busy` (timeout 0.5 s) for each
`SING_YIELD_URLS` URL every `poll_s` (0.1 s), once at start. Any `busy > 0` sets
`busy_until = now + hold_s`, `hold_s = max(SING_YIELD_HOLD_MS / 1000, 2 × poll_s)` (0.3 s; table
`yield.hold`). A worker that does not answer counts as idle. In the gate: if busy, the allowance is
set to `yield_allowance()` (`yield_max_s` when urgent or `people is False`, else `yield_patient_s`;
table `yield_allowance`), then the job sleeps in 20 ms steps while busy, until the allowance used
by this job in total reaches it ("going on regardless"). Time spent yielding is not step time.
Polling stops at `_give_gpu_back`. Scenarios `yield_patience_*`, `share_24gb_people_she_speaks_mid_song`.

## 8. The speech workers' side (peer protocol)

Both workers keep their model in a child process; to offload is to kill it, which returns all its
VRAM. All routes take a bearer token when hostd set one (`service_auth`).

| Request | Reply (200 unless noted) |
|---|---|
| `POST /offload {reason?: string, max_s?: number, drain_s?: number}` (TTS reads `drain_s`; unknown fields ignored; a body of the wrong type → 400 `{"error": "invalid request: …"}`) | fresh: `{"state": "offloaded", "offload_ms", "vram_before_mb", "vram_after_mb", "device_used_before_mb", "device_used_after_mb", "released_mb"}` (TTS adds `"drained": bool`); already offloaded: `{"state": "offloaded", "offload_ms": 0, "already": true, "since", "reason", "reload_at"}`; during a reload in a child: the child is killed, `{"state": "offloaded", "offload_ms": 0, "cancelled_reload": true, …device fields}`; during a reload in-process (`*_ENGINE_PROCESS=0`): `{"state": "reloading", "offload_ms": 0}` and **no lease is set** |
| `POST /reload` | loaded: `{"state": "ready", "reload_ms": 0, "already": true}`; else waits for the load (one load shared by concurrent calls; the auto-reload timer is cancelled): `{"state": "ready", "reload_ms", "vram_mb", "device_total_mb", "device_used_mb", "device_free_mb"}`, or `{"state": "offloaded", "cancelled": true}` when an offload stopped it |
| `GET /busy` | `{"busy": n}`: ASR `/asr` requests under way (from upload to answer); TTS utterances being synthesized |
| `GET /health` | `{"status": "ok", "offloaded": bool, "loading": bool, "released_mb": int|null, …}`; while offloaded also `since`, `reason`, `reload_at`; device fields when NVML works |

On their own:
- **Lease**: every `/offload` (fresh or not) restarts a timer of `max_s` (default
  `ASR_OFFLOAD_MAX_S` / `TTS_OFFLOAD_MAX_S` = 900 when the request names none; `0` = never). When
  it fires, the worker reloads itself. `/reload` cancels it.
- **Drain** (TTS only): new `/tts` calls get 503 `{"error": "offloaded"}` at once; utterances under
  way get `drain_s` (`TTS_OFFLOAD_DRAIN_S`, 15 s; the song worker sends none) to finish, then stop
  at their next chunk. ASR answers 503 to new requests and waits only for the running one.
- **Crash** (TTS): a child that died by itself is restarted, with `reason: "engine crashed"`.
- `released_mb` is measured on the device after the memory settles (`device_memory.settled`: reads
  every 0.1 s until used memory stops falling by more than 32 MB for 0.5 s, at most 3 s).

## 9. What Core contributes, and image generation

- **Context**: §3.4. Pushed only while a song is preparing, every 1.5 s; the worker's TTL is 20 s.
- **Go** (`packages/sing/src/singer.ts`): when a job's `exclusive` is `waiting`, she announces
  that she is off to prepare the song (unless she is not in voice: go at once; or she announced
  within `prepare_notice_gap_secs`, 180 s: go as soon as she is not speaking). Go is sent when she
  spoke and was quiet for `quiet_ms` (700 ms), or did not start within 8 s, or after
  `announce_max_secs` (20 s). Speech is paused from `offloading` until the window is over.
- **Image generation** (`ImageGenService`, `pause_while_singing` and `free_on_sing`, both on by
  default): while a song is **being prepared** (any stage, CPU or download included: Core's
  `SingPrepare` event has a song) or **sung**, no image job starts and a running **batch** job is
  interrupted and requeued; when that period starts, ComfyUI is asked to unload
  (`POST /free {"unload_models": true, "free_memory": true}`). ComfyUI is also unloaded after
  `free_after_idle_s` (120 s) without work. The song worker knows nothing of this: ComfyUI's memory
  is simply missing from the device reading. Moving this into hostd is deferred (§12.2): it
  changes when ComfyUI unloads, which needs the owner, and the module stays closed until a model
  is chosen.

## 10. Oddities and doc/code mismatches

Not fixed unless the item says so. A fix changes the Python, the recorded table and scenarios,
and the arbiter together.

1. `server.py`'s docstring lists `SING_GPU_POLICY auto | share | offload | wait (default auto)`.
   The code's default is `yield`, and `yield` is missing from the list.
2. `gpu.py`'s docstring says that under `yield` "only Demucs' separation (`CPU_FALLBACK`) goes to
   the CPU instead" of taking her voice. The code sends a `CPU_FALLBACK` stage to the CPU only
   when speech cannot help (`not can`) or during a gap; otherwise it takes a window like any stage.
3. **Fixed 2026-11-16**: under `yield` a job that her voice cannot help (`offload_useless`, or
   speech already offline) waited for room for ever. It now fails with the reason after
   `wait_max_s` of waiting in all, as `auto` does (scenarios
   `yield_spill_inside_a_window_gives_up`, `yield_never_enough_room`). Still true: `yield`
   ignores `freed_mb` (`helps`), `people`, `defer_s`, `room_wait_s` and the silence estimate for
   opening a window.
4. **Fixed 2026-11-16**: her voice was given back after the lead's conversion while the job's
   `window` flag stayed set, so a `backing: "convert"` pass was placed `exclusive/window` and
   ran on the GPU while TTS and ASR were reloading, with yielding already stopped. The passes
   now run one after the other (`_convert_passes`), each placed as a stage of its own, and her
   voice is given back once, after the last. A window the first pass opened holds the second
   under the same silence limit; a pass stopped by the limit goes on from its step in the next
   window (scenarios `backing_*`).
5. Three different "how long to wait for go": `Exclusive`'s own default `ack_wait_s` 20 s, the
   server's `SING_EXCLUSIVE_WAIT_S` default 30 s (the one in effect), and Core's
   `announce_max_secs` 20 s plus up to 8 s before she starts.
6. The silence clock of a window starts when the offload has finished (`window_opened`), but Core
   pauses her speech from `offloading` on; the ack wait and the offload (seconds; TTS may drain
   15 s) are not counted, and the reload is counted only by its learned estimate. With a reload
   of 87 s (11-07) the real silence is about 45 + 87 s, not "90 s, reload included". The limit
   is unchanged; since 2026-11-16 each window's real silence is recorded next to it: the job's
   summary has `windows`, one `{ offload_s, work_s, reload_s, silence_s, limit_s }` per window
   (`work_s` is what the limit bounds, `silence_s` runs from the first offload asked to her
   voice back, `limit_s` is null when nobody listened).
7. **Fixed 2026-11-16**: `silenced_s` and the gap run from `window_opened` to `window_closed`,
   and for the last window `window_closed` was called only at the end of the job (after mix,
   beats, lyrics and video), so the next job's gap started late. The window now closes when her
   voice is back after the conversion.
8. Under policy `offload` a window has no silence limit at all, whoever listens.
9. `Exclusive` counts any reply of `/offload` as offloaded, including `{"state": "reloading"}`
   from a worker with an in-process engine, which did not offload and set no lease.
10. A speech worker that does not answer `/health` counts as **loaded** (so the job may still try
    to offload it), but one that does not answer `/busy` counts as **idle**.
11. `SING_GPU_SHARE` other than `"1"` (`true`, `yes`) means `offload`. An integer limit written as
    `1.5` silently falls back to its default.
12. A job submitted without `exclusive_ack` and before any context counts as "nobody listening"
    (`people` false), so under `auto` it may take her voice at once.
13. `waited_s` (for `defer_s`, `room_wait_s`, `share`'s spill wait) is the current placement loop
    only; `wait_max_s` uses the job's total. A suspension restarts the former.
14. `share` after a spill waits `defer_s` and then shares again, even though nothing changed
    (scenario `share_policy_spill_reduces_then_waits`).
15. The decision history drops a decision whose `mode/code` equals the previous one, so a changed
    reason (people turning unknown during `wait/no_room`) is not recorded.
16. `round()` in the headroom is half-to-even; JavaScript's `Math.round` is half-up. The table
    has such cases (`headroom`, `headroom_pct` 12.5).
17. The RVC warm-up process (`rvcpass`) can hold VRAM outside any stage (it is kept between
    queued jobs); stages wait for it (`wait_warm`) but it counts only as "less free memory".
18. `/health`'s `gpu.policy` is read from the environment at each request, while a job keeps the
    policy it started with.

## 11. The recorded table and scenarios

`gpu_decisions.json`: a `header` (defaults of every limit and the variable behind it, constants,
the base input per function, case counts) and one case per line `{"fn", "in", "out"}`. For
`decide`, `gather` and `tick` the input is `header.bases[fn]` with `in` laid over it; a `limits`
object is a change of `header.limits_default`. Grids are generated, placed just below, at and above
each threshold, and every outcome code of `decide` and `tick` occurs.

| Function | Cases | What varies |
|---|---|---|
| `decide` | 1773 | early exits × policy; fit boundary (want ± 1, own memory, crowded ± 0.4 MB, burst); `auto` people × urgent × speech × useless × gap × freed; waits around `defer_s`/`wait_max_s` × silence estimate around 90 s × small card; `room_wait_s`; `yield`, with its waits around `wait_max_s`; `share`/`offload`/`wait` |
| `tick` | 673 | spill detection (normal known or not, step window below/at/above the limit, free none/plenty/= headroom/< headroom/2, low reads); responses per stage × policy × window × reduced × speech × useless × gap × urgent/people; the silence limit around 45 s and 60 s |
| `gather` | 53 | card (none, unreadable, raising, 12 GB, own memory), profile fresh or learned, speech loaded/offloaded/one down, `cpu_only`, `CPU_FALLBACK`, wait and gap state |
| `headroom` | 108 | total × percent × learned, half-to-even cases |
| `typical_peak` | 125 | multisets of 1 to 5 peaks around twice the median |
| `audience.people` | 98 | age none / 0 / 19.9 / 20 / 20.1 × flags × `core_expected` |
| `limits_from_env` | 85 | each variable unset, valid, padded, fractional/exponent, invalid |
| `silence_estimate` | 72 | audio length × converted share × stage × learned rates |
| `policy_from_env` | 45 | both variables |
| `speech.read`, `speech.read_cache` | 43, 8 | per-worker replies, the 2 s cache |
| `server.recover_speech` | 34 | each worker's `/health` × reload failing |
| `profile.note_step/spill/healthy` | 21, 30, 12 | learning arithmetic |
| `server.urgent`, `yield_allowance`, `yield.hold` | 15, 12, 5 | |

`gpu_scenarios.json`: 31 scenarios. The real `server.py` job loop (`run_job`, `_gpu_stage`,
`_place`, the gate), `GpuJob`, `Exclusive` and `SpeechYield` run their own threads on a simulated
clock, one at a time; the device, the speech workers (a model of §8 with made-up timings: TTS
4700 MB, offload 3 s, reload 20 s; ASR 1500 MB, 1 s, 8 s), Core (context every 1.5 s, go 4 s after
`waiting`) and the stages (fixed step times) are fakes. Each scenario has its `setup`, the
`result` (job outcome, the job's GPU summary, the last `Exclusive`, yielding, speech worker
states, what was learned) and `events`: state changes (`stage`, `exclusive`, `window`, `running`,
`yield_pauses`, each speech worker), every POST with body and reply, every recorded decision with
its reason, and the script's own events. Scenarios: sharing on 24 GB while she speaks; `yield`
windows with go, without go (30 s), long song with bounded windows and gaps, alone then someone
joins, Demucs separation; `auto` waiting then a short window, waiting the maximum, urgent, Core
going quiet mid-wait, Core gone with a window open; a speech worker unreachable; the holder dying
(restart after and before the lease); spills while sharing, in separation, inside a window under
`auto` and under `yield` (both fail after `wait_max_s`); `yield` with no room and nothing to
offload; a `backing: "convert"` job (one window for both passes, the silence limit falling in
the backing pass, `auto` with people, sharing while she speaks); out of memory then a window;
yield patience urgent and not; policies `share`, `wait`, `offload`; no CUDA; the RVC stage and
her voice's burst.

**Not covered** by either file, and why:
- `device_memory` (NVML through ctypes), `settled`, `report`, the torch readings
  (`memory_reserved`, peak stats, `synchronize`): they need the device; described in §3.3 and §8.
- The engine's own out-of-memory fallback inside `RealBackend.separate` and `split_lead` (an OOM
  there retries on the CPU without asking `gpu.py`), and the Seed-VC/RVC internals.
- `GpuJob.finished` / `stopped` gating of what is learned (clean run, tight first run, resumed
  run): only the arithmetic is tabled; the scenarios show its effect on `learned`.
- The speech workers' real code (asyncio servers): modelled in the scenarios;
  `tests/test_asr_offload.py` covers the ASR lease and self-reload. TTS drain is not exercised.
- HTTP timeouts (offload 60 s, renewal 5 s, reload 300 s, `/health` 0.5 s and 2 s, `/busy` 0.5 s):
  the fakes answer or refuse at once.
- Core's announcement logic (modelled as "go 4 s after waiting") and image generation (§9; no
  Python involved).
- Cancellation paths (the cancel checks in the placement loop, the ack wait and the gate).

## 12. Mapping to hostd

Decided 2026-11-16 (the twelve questions of the first version of this section, all answered as
recommended, image generation deferred) and built in H7b part 1: `packages/hostd/src/arbiter`
(not wired into the daemon yet), the shapes in `@miyoria/contracts/host` (`gpu.ts`), and three
tests in `packages/hostd/test/arbiter`. H7b part 2 added the Python lease client behind a switch
(§12.6, §12.7); the worker keeps deciding by itself by default until the owner has heard a live
song request in a voice call on the new path.

### 12.1 Where each recorded function lives now

Every row of `gpu_decisions.json` is reproduced exactly by `test/arbiter/table.test.ts` (3 212 of
3 212, no tolerance). Worker-side functions stay in Python, where their rows keep guarding them;
the test also checks the TypeScript copies the scenario harness uses to play the worker.

| Function | Lives in | Rows |
|---|---|---|
| `decide`, `tick`, `gather` (with the worker's values from the request) | hostd: `rules.ts`, `job.ts` | 1773, 673, 53 |
| `headroom`, `profile.note_spill`, `profile.note_healthy` | hostd: `CardProfile` | 108, 30, 12 |
| `audience.people` | hostd: `Audience` | 98 |
| `speech.read`, `speech.read_cache` | hostd: `SpeechReader` | 43, 8 |
| `yield_allowance`, `yield.hold` | hostd: `rules.ts` | 12, 5 |
| `server.urgent` | hostd: `urgentOf` (the worker sends its queued job ids) | 15 |
| `server.recover_speech` | hostd: `Arbiter.recover` at hostd's start | 34 |
| `policy_from_env`, `limits_from_env` | hostd: `policyFrom`, `limitsFrom` (same names and parsing, from host settings) | 45, 85 |
| `silence_estimate` | both: the worker estimates the work left, hostd adds the learned reload time | 72 |
| `typical_peak`, `profile.note_step` | the worker | 125, 21 |

### 12.2 The protocol

All durations are seconds (the table's arithmetic is Python's, float for float). The shapes are
`HostGpu*` in `contracts/host/src/gpu.ts`; the holder is the calling service (the local API knows
it from the service token).

- **Placement** (`_place`): `gpu.acquire { job, stage, on_gpu, pauses, need_mb, own_mb,
  est_work_s, est_work_by_card, cpu_fallback, queued, ack, resumed, max_s }`, asked again every
  `check_s` while the answer is a plain `wait`. Answers: `granted { mode: share | exclusive,
  free_mb }`, `wait { code, reason, announce, evict }`, `cpu`, `refused { reason }` (give up).
  hostd counts the job's waits: "this wait" from the first `wait` until the placement ends
  (`granted`, `cpu`, `refused`, or the granted window after an announce), the total over the job.
- **Taking speech offline** (decision 2): a decided eviction is answered `wait` with
  `announce: true` and the services in `evict`. The worker shows `exclusive: "waiting"` (with
  `ack`), waits for Core's go or `SING_EXCLUSIVE_WAIT_S`, shows `offloading`, and asks again with
  `announced: true`; hostd then offloads the services in turn without deciding again and answers
  `granted` with `evicted`, `errors`, `released_mb`, `offload_s`. The worker shows `active`.
  hostd renews the services' own lease (`max_s` = `lease_s`, 60) every `lease_s / 3`.
- **Every step** (the gate, GPU and CPU stages alike): `gpu.busy { lease }` → `{ busy,
  allowance_s }` (the worker's 20 ms pause loop asks it again while busy), then `gpu.renew {
  lease, own_mb, queued, step: { recent_s, normal_s } }` → `{ action, clear_steps }`. hostd runs
  `tick`: the card at most every `check_s`, the window's silence limit, the spill test and
  response. `action` is `trim`, `reduce { steps }`, `offload` (open a window between two steps:
  as an announce, then `gpu.acquire` with `announced`), or `suspend { code }` (`silence_limit`,
  `spill_cpu`, `spill_wait`).
- **Stage end**: `gpu.renew { end: { how: finished | suspended | oom, step_s, normal_s } }`.
  After `finished` the answer's `learned { card, drop_mb, note_step, note_rate }` says on which
  card to learn, how far free memory fell (the peak a subprocess hides), and whether the run's
  step time and rate count. After `oom` hostd remembers the room (`crowded`). After a suspension
  or OOM with a window open: `gpu.release { window: "close" }` (speech back, waited for), then
  placement again.
- **After the conversion's last pass** (`_give_gpu_back`): `gpu.release { window: "close" }`, on
  its own thread: speech comes back while the song is mixed, and the window ends when it is back
  (until 2026-11-16: `keep`, the window stayed open to the job's end; oddities 4 and 7). The
  answer's `window` is the record of the window it closed. **At the job's end** (done, failed or
  cancelled): wait for that, then `gpu.release { window: "close", done: true }` → the job's
  summary for `meta.json`, with `windows`.
- **Keep-alive**: the job's lease ends after `max_s` (60) without a call; the worker sends a bare
  `gpu.renew { lease }` whenever 20 s passed since its last call of any kind (the ack wait, a long
  reload, the mix).
- **Core**: `cluster.context { in_voice, listeners, live, urgent }` to hostd, every poll while a
  song is prepared (today's push, other address); the TTL rule stays 20 s. Core keeps reading the
  job's `exclusive` field from the worker for its speech pause and its go (decision 12).
- **Holder gone**: when hostd sees the holder's process exit (`holderGone`) or its lease expire,
  it brings speech back at once and forgets the job. At hostd's own start, `recover` reloads a
  service left offloaded for a holder (today's `_recover_speech`).
- **A share-only tenant** (`mode: "share"`): where an exclusive one would be told to announce,
  it gets a plain `wait`. Image generation is deferred (decision 9): Core's existing ComfyUI wiring
  stays, and ComfyUI can be added later as such a tenant.

### 12.3 How the scenarios are compared

`test/arbiter/scenarios.test.ts` plays each recorded scenario against the real `Arbiter` on a
simulated clock. The song worker is a port of server.py's job loop in which every GPU question is
one of the calls above; the card, the speech services, Core and the stages are ported fakes. The
rule, written in the test's header too, as strict as it can be:

1. Calls to the speech services (with body and reply): same list, order and times (ms).
2. Decisions (`mode/code`, stage, reason): same list, order and times.
3. Other events (Core's go, card changes, trim and unload, a service reloading by itself, the
   job's end, the horizon): same list, order and times.
4. Observed states (`stage`, `exclusive`, `window`, `running`, `yield_pauses`, each service):
   the value at the end of every instant, as a timeline of changes. Not compared: the order of
   events of different kinds within one instant, and a value held only in the middle of an
   instant. Both depend on which thread the recorder's probe ran in; no peer can observe them.
5. The result: outcome, the job's summary, the last window's record, yielding, the services'
   states, what was learned about the card, the end time, the steps run per device. Not
   compared: how often `/health` and `/busy` were asked, and the new `gpu.*` exchanges.

All 31 scenarios pass this rule. The two `holder_dies_*` scenarios are compared up to the death;
after it the behaviour changes on purpose (v5-hostd §8): hostd reloads both services at once when
the holder exits (tts at the death, asr 20 s later), where the recording shows them offline until
their own lease ran out (54 s later) or the worker restarted. The test asserts the new behaviour.

### 12.4 What the decisions needed beyond what they said

- **Per-card values.** The worker learns per card (`name/total_mb`), and gpu.py takes the card's
  values only after reading the card in the same call. Since only hostd reads the card, the worker
  sends its learned need, normal step and work estimate per card (`need_mb`, `step.normal_s`,
  `end.normal_s`, `est_work_by_card`) and hostd takes the entry of the card it just read, else its
  prior. Eight table rows (unreadable or missing card with a learned profile) fail otherwise.
- **The announce handshake for every eviction**, not only with `ack`: the worker must show
  `offloading` while the services are taken offline (Core pauses her speech on it), and it can
  only know an eviction is coming if hostd says so before doing it. Without `ack` the worker asks
  again with `announced` at once.
- **`gpu.renew` before every step, not once a second**: gpu.py checks the silence limit and the
  spill rules before every step; once a second would move a window's end by up to a second.
- **Busy polling while a job holds any lease**, not only a sharing one: CPU stages yield to her
  speech too. hostd polls `/busy` every 100 ms from the job's first `gpu.acquire` to its final
  release.
- **The worker sends what hostd cannot see**: `own_mb` (its own reserved memory, counted as
  room) on every call, and `queued` (the ids of jobs queued behind it, for urgency).
- **Two kinds of release** (`keep`, `close`), so the window lasts until the job's end as today.

### 12.5 The arbiter's interface (for the daemon wiring)

`new Arbiter(options)` with:
- `clock` and `timers` (seconds; `timers.sleep(s, signal)` rejects at once on abort);
- `readDevice()` → `{ cuda, total_mb, free_mb, name }` of the whole device, other processes
  included (NVML or `nvidia-smi`; `free = total − used`), throwing when it cannot be read;
- `peers`: `offload(tenant, { reason, max_s }, timeout_s)`, `reload`, `busy`, `health`, HTTP with
  the service's token, throwing on a failed call;
- `tenants` (`tenantsFrom(descriptors with URLs)`, in offload order: TTS, then ASR, as today) and
  `holders` (`holdersFrom`, the `on_demand` names);
- `policy`, `limits` (`policyFrom`, `limitsFrom` over host settings with the `SING_*` names),
  `profile` (a `CardProfile` over a JSON file in the state folder), `onEvent` (logging).

The daemon routes `gpu.acquire` (with the caller's service name as holder), `gpu.renew`,
`gpu.release`, `gpu.busy`, `gpu.state` to it after parsing with the contract schemas; passes
`cluster.context` to `context()`; calls `holderGone(name)` when a service's process exits;
`recover()` at start; `close()` at shutdown.

### 12.6 The song worker as a lease client (H7b part 2)

`SING_GPU_ARBITER` picks who decides: `self` (the default, today's code, unchanged in behaviour:
the recorded table and scenarios are reproduced without a diff) or `hostd` (`workers/sing/lease.py`).

**One seam.** server.py's job loop (`_gpu_stage`, `_give_gpu_back`, `run_job`, `/gpu/context`,
`/health`) calls an arbitration object chosen at start: `SelfArbitration` in server.py, which only
delegates to the functions that were there, or `HostdArbitration` in lease.py. Both have the same
methods: `start`, `place`, `arm` (the gate), `run_begins`, `run_ended`, `close_window`,
`give_back`, `finish`, `startup`, `context`, `health`. In `hostd` mode `job.gpu`,
`job.exclusive` and `job.yielding` are lease.py's `LeaseJob`, `LeaseWindow` and `LeaseYield`, with
the same fields and shapes as gpu.py's `GpuJob`, exclusive.py's `Exclusive` and yielding.py's
`SpeechYield`, so what Core and the panel read (`exclusive` and its states, `stage`, `gpu`,
`yielded`, the summary in `meta.json`) means the same in both modes. `/health`'s `gpu` section
gains `arbiter: "self" | "hostd"`; in `hostd` mode its other fields come from `gpu.state` (read
at most every 2 s) and the worker's own per-stage learning. hostd's summary of a job, known only
when its lease ends, replaces the provisional one in `meta.json`.

When `self` goes: delete `SelfArbitration`, `_start_gpu`, `_place`, `_open_window`,
`_close_window`, `_act`, `_arm`, `_urgent`, `_recover_speech` and `State.offload_post` /
`busy_get` from server.py; exclusive.py and yielding.py; in gpu.py everything but `Profile`
(per-stage half), `StepMeter`, `typical_peak`, `RATE_PRIORS`, `CPU_STAGES`, `CPU_FALLBACK`;
`SING_OFFLOAD_URLS`, `SING_YIELD_URLS` and the other `SING_*` limits hostd now reads; the self
half of the table test; and the switch itself.

**What the worker sends, and when**: §12.2, implemented as listed there, plus `gpu.state` once
when a job's first GPU stage starts (the policy the job shows). The keep-alive is a bare
`gpu.renew` 20 s after the last call of any kind, so it also runs during the ack wait and during a
long reload. In `hostd` mode the worker makes no call to the speech workers, does not run
`_recover_speech`, and answers `POST /gpu/context` with `{"ok": true, "ignored": ...}` (logged
once). Core's go (`POST /jobs/{id}/exclusive`) works as before.

**When hostd cannot be asked**:

| Case | What the worker does | Limit and why |
|---|---|---|
| `SING_GPU_ARBITER=hostd` without `MIYORIA_HOSTD_URL` and `MIYORIA_SERVICE_TOKEN`, or another value | refuses to start, saying which | a wrong switch must not become self-arbitration |
| hostd unreachable or erroring while a stage is placed (`gpu.acquire`) | holds nothing, `stage: gpu_wait`, asks again after 0.5, 1, 2, 4, then every 5 s | `SING_OFFLOAD_LEASE_S` (60 s), then the job fails: "hostd did not answer gpu.acquire for 60 s: …". hostd's lease for a silent holder is 60 s: past it hostd has dropped the job and brought speech back, so nothing the job waited for is left. Steps stay under 5 s, the old renewal timeout, so a restarting hostd is noticed within seconds |
| `gpu.renew` fails, or answers `ok: false`, before a step | the stage lets go (suspend `hostd_unreachable`), a window counts as released (a failing `close` release is recorded in the window's errors), then the stage is placed again as above | giving the card back costs the song time at most; running on would keep her voice offline with nobody keeping the silence limit. Her voice does not depend on the worker: hostd renews the speech workers' lease only while it lives, and they reload themselves when that lease runs out |
| `gpu.busy` fails | counts as not busy | as a speech worker that did not answer `/busy` |
| `gpu.release` fails | the window is recorded as given back, with the error | as above |
| `refused` | the job fails with hostd's reason | |

### 12.7 The cross-check between the Python client and the TypeScript arbiter

`packages/hostd/test/arbiter/scenarios.test.ts` records, for each of the 31 scenarios, every
`gpu.*` call its worker made to the real `Arbiter` and the answer, in simulated seconds, into
`lease_exchanges.jsonl` (JSON Lines; `UPDATE_LEASE_EXCHANGES=1` rewrites it, otherwise the test
fails when it is stale). `workers/tests/test_gpu_lease_replay.py` runs the song worker's real job
loop with `SING_GPU_ARBITER=hostd` on the Python recorder's simulated clock against a hostd that
answers from that file. The rule, as strict as the recording allows:

1. Every call is the next recorded one with the same params, at the same simulated time to the
   last bit. A run of equal calls answered at once is stored as one entry: same params each time,
   the first and last at the recorded times, the count equal, the ones between within them.
   `gpu.busy` calls must fall in a recorded run of equal answers, with the same count per run. A
   call answered later in the recording is answered at the recorded time.
2. Every recorded call is made.
3. What the job shows against the Python worker's own recording (`gpu_scenarios.json`), by the rule
   of §12.3: the worker's states (`stage`, `exclusive`, `window`, `running`, `yield_pauses`) as
   end-of-instant timelines, its own and the script's events in order, and the result.

All 26 pass. A one-second change of the keep-alive period fails 16 of them.

What it proves: the Python client asks hostd exactly what the TypeScript harness's worker asked,
when it asked it, and, given the arbiter's answers, ends where the self-arbitrating worker ended.
With §12.3 (the arbiter's answers reproduce the self-arbitrating worker's speech calls and
decisions), the two halves are checked against each other rather than each against its own fake.
What it does not prove: the transport (`hostd_client.py`, the daemon's routing and schema
checks), real time and real thread interleaving, the speech services themselves, and the failure
paths (those are covered by `workers/tests/test_sing_lease.py` against a scripted hostd).
Answers are replayed, so a request hostd would answer differently shows up only as a different
request.

### 12.8 Before a live test

- **Daemon wiring** (`packages/hostd` outside `arbiter`): construct the `Arbiter` (§12.5); route
  `gpu.acquire` (holder = the calling service), `gpu.renew`, `gpu.release`, `gpu.busy`,
  `gpu.state` from the local API after parsing with the contract schemas; pass
  `cluster.context` from the control link to `context()`; call `holderGone(name)` when a
  service's process exits; `recover()` at start; `close()` at shutdown. The real device reader
  (free = total − used, the whole device), the peer client (HTTP with each service's token,
  timeouts in seconds), the `CardProfile` file in the state folder, and the policy and limits
  from host settings.
- **The sing service under hostd** gets `SING_GPU_ARBITER=hostd` and the hostd variables in its
  environment; `SING_OFFLOAD_URLS` is then unused. (Its `service.toml` is not this step's.)
- **Core**: send `cluster.context` to the hosts that hold `tts` or `asr`, on the same poll and
  with the same fields as today's `/gpu/context` push; keep the go and keep reading the job's
  `exclusive`. The old push can stay until the self path is deleted (the worker ignores it).
- **Contracts** (not this step's files): `WorkersSingHealth.gpu` may describe the new `arbiter`
  field; nothing is strict about it today, so nothing breaks without it.
- Image generation stays as it is (decision 9).
