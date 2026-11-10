# Live2D files (not in git)

`vendor/` holds Live2D's own code, under Live2D's licences, fetched on each machine that renders
cards:

| Path | Source | Licence |
|---|---|---|
| `vendor/live2dcubismcore.min.js` | `https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js` (Core 5.1.0 on 2026-11-09) | Live2D Proprietary Software License |
| `vendor/framework/` | `git clone --depth 1 --branch 5-r.4 https://github.com/Live2D/CubismWebFramework.git vendor/framework` | Live2D Open Software License |

The framework must match the Core: 5-r.5 calls `csmGetMocVersion(mocBytes)`, which Core 5.1 does
not have. Her model (Cubism 5, moc3 v5) loads with Core 5.1 and framework 5-r.4.

Then `pnpm --filter @miyoria/card-studio build`, and `pnpm --filter @miyoria/card-studio sample
<out>` renders samples (`SAMPLES_FILE` names a JSON of pose specs).
