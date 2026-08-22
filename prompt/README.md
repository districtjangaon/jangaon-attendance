# prompt/

Reusable prompts extracted from work done in this repo, for use on other
projects. Nothing in here is imported by the app or the console — it is
documentation.

| File | What it is |
|---|---|
| `dashboard-charts-prompt.md` | **Paste this into a coding agent.** Rebuilds the dashboard chart system: aligned card grid, right form per chart, validated palette, safe gradients, real dark mode. |
| `reference/charts.js` | The finished toolkit from this repo — bar, hbar, meter, stack, donut, line, heatmap, spark. Dependency-free, no CDN, no build step. |
| `reference/charts.css` | The grid, card, plot box and HTML mark styles, plus the light/dark colour tokens. |

## How to use it

1. Paste `dashboard-charts-prompt.md` (everything below its `---`) as the task.
2. Attach `reference/charts.js` and `reference/charts.css` as the starting
   point if the target project has no chart layer yet, or as a worked example
   if it does.
3. Tell the agent your project's surface colours (light and dark) and your
   brand's hues. The method is design-system-agnostic; only those values change.

## What the reference implementation assumes

Rename these to whatever the target project calls them — they are the only
app-specific names in the two files:

- `--surface`, `--line` — card background and hairline border
- `--font-display`, `--font-mono` — UI sans and the numeric/mono face
- `body.dark` — the dark-theme scope
- `.tablewrap` — a horizontally scrolling wrapper (used by the heatmap)

Everything else — `--s1`…`--s8`, `--o1`…`--o5`, `--st-*`, `--ch-*` — is defined
by the chart system itself and travels with it.

## Two things worth keeping

**Run the palette validator; don't reason about ΔE.** The palette that was
already shipping here failed on a pair that measured ΔE 7.8 for *normal* vision
against a floor of 15. Nobody had noticed.

**Render it and look at it before calling it done.** The last pass caught four
defects a validator cannot see, one of which drew events that never happened.
