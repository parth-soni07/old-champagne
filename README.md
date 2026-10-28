# old-champagne: UK wind day-ahead pilot portal

The UI of a pilot portal for a UK energy buyer. It shows the latest national wind forecast that was
available at the day-ahead decision time, against what the wind actually delivered, and how much
backup that error should cost. Data comes from the API in [ethan](https://github.com/parth-soni07/ethan).

**Live app:** https://old-champagne.vercel.app

## AI tools disclosure

AI tools were used to build this project. Claude Code (Anthropic) helped with scaffolding, code,
tests and documentation. I reviewed, ran and verified all output, and I own the design decisions
and the analysis.

## What's on the page

- **Decision time** (header): the cutoff on the day before delivery. Every number on the page follows it.
- **The month at a glance**: four stat tiles (typical miss, bias, backup for 90% cover, relative
  error), each with a daily sparkline and the selected day marked.
- **Pick a day**: a calendar whose tiles carry each day's typical miss, and the day's forecast
  against actual output.
- **What the month taught a buyer**: the hourly backup to hold (the procurement answer, full width),
  then over-forecast by wind level, miss by forecast age with the day-ahead window highlighted, and
  the error distribution.

Every chart is read by **scrubbing**: hover, drag or swipe (or focus it and use the arrow keys), and
the readout strip under the plot shows every figure for that bar. **csv** exports the exact values.

## Design decisions, and where they come from

| Decision | Why | Source |
|---|---|---|
| Claymorphism: one large offset drop shadow plus two inner shadows, pastel fills that differ from the page | Reads as inflated 3D surfaces; neumorphism (surfaces the same colour as the page) reads flat | M. Malewicz, "Claymorphism in user interfaces", hype4.academy |
| Charts use emphasis: the bar the story is about in blue, the rest grey, one value label | One story per chart; colouring every bar buries it | dataviz method: choosing a form, anti-patterns |
| Blue / orange for actual vs forecast and for spare wind vs shortfall | Passes colour-blind separation (CVD ΔE 31.8); the earlier green/orange failed (ΔE 3.5) | `validate_palette.js` |
| Titles state the finding ("hold 5.4 GW at 02:00"); clean 0/2/4/6 ticks, unit shown once | Lead with the answer; less axis noise | dataviz marks & anatomy |
| Scrub readout instead of tooltips or a table view | Values stay readable without a mode switch or sideways scrolling; keyboard focus shows the same as hover | dataviz interaction ("tooltips enhance, never gate") |
| Turbines in the background spin at the selected day's real wind | The backdrop explains the data: calm days slow them down | product choice |
| Wind streaks pushed by the pointer, on one canvas | One batched path per frame, integer coordinates, no blur, DPR capped at 2 | MDN, "Optimizing canvas" |
| Rotors and clouds animate `transform` only, via the Web Animations API | Compositor-only motion; speed changes use `playbackRate` without resetting rotation | modern-web-guidance: motion |
| Reduced motion starts static; a pause button is always there | Persistent animation needs a pause control | modern-web-guidance: motion, accessibility |
| Nunito (headings) + Plus Jakarta Sans (text) | Rounded terminals echo the clay shapes; Inter is listed as generic | taste-skill soft-skill; typography guide |
| Lowercase copy, but `GW` / `MW` stay uppercase | `mw` would read as milliwatts | SI unit symbols |

## Layout

| Path | What |
|---|---|
| `app/page.tsx` | The page: data loading (cached, prefetched on hover), stat tiles, calendar, scrub-to-read charts |
| `app/scene.tsx` | The animated landscape and the pointer-reactive wind canvas |
| `app/globals.css` | Clay tokens, Apple system palette, layout |
| `app/layout.tsx` | Fonts and metadata |
| `next.config.ts` | Static export for builds; `/api` proxy to a local ethan for `next dev` |
| `Dockerfile`, `docker/default.conf.template` | Static build served by unprivileged nginx, which proxies `/api` to ethan |

## Run

```bash
# Local: start ethan first (see its README), then
npm install && npm run dev                      # UI on :3000, proxies /api to http://localhost:8000
API_URL=http://localhost:9000 npm run dev       # if ethan runs elsewhere

# Docker (with ethan reachable at API_URL)
docker build -t old-champagne .
docker run -p 8080:8080 -e API_URL=http://host.docker.internal:8000 old-champagne
```

## Configuration

| Env var | When | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | build time | Origin of the ethan API, e.g. its Vercel URL. Empty (default) means same origin (dev proxy, or nginx in Docker) |
| `API_URL` | `next dev`, Docker runtime | Where `/api` is proxied to. Default `http://localhost:8000` (dev), `http://ethan:8000` (Docker) |

## Deploy

On Vercel, set `NEXT_PUBLIC_API_BASE` to the ethan deploy's URL, and set ethan's `ALLOWED_ORIGINS`
to this deploy's URL.
