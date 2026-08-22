# Prompt — build a dashboard chart system that isn't ragged

Paste everything below the line into your coding agent. It is written to be
project-agnostic: it names no framework, no chart library, and no brand.

---

## The task

Rework the charts on this project's dashboard. Three outcomes, in priority order:

1. **Every card in a chart grid must line up.** Same card height, same plot
   height, plot starting at the same offset from the top of the card.
2. **Each chart must use the right form for its data's job** — not whatever
   form it happens to have now.
3. **Colour must be computed and verified, not chosen by eye**, and must work
   in both light and dark themes.

Gradient accents are wanted, but only in the safe form defined below.

## Rule 0 — do these in order, and colour comes LAST

Pick the form → assign colour by the job it does → **validate the palette** →
apply mark specs → render it and look at it. Most bad charts pick colours
first. If you are using Claude Code, load the `dataviz` skill before writing a
line of chart code; it carries the validator and the full reference.

---

## 1. Why grids look ragged (fix this first)

The cards are almost never the problem. The usual cause is that magnitude
charts are drawn into a **scaled SVG `viewBox`**. That ties row height to row
*count*: a 10-row chart and a 3-row chart sitting side by side end up with
visibly different bar thicknesses and baselines, because both are stretched to
the same container width and their heights follow their own aspect ratios.

**Fix:** lay out magnitude charts (bars, rows, meters, stacked shares) in
**HTML** at exact pixel sizes. Keep **SVG** only for arcs, lines and grids,
where the geometry actually needs it. HTML also gives you real hover targets,
text that wraps and truncates properly, and no font scaling surprises.

Then make the grid itself deterministic:

```css
.charts {
  display: grid;
  /* auto-FILL, not auto-fit: auto-fit stretches a partial last row to double
     width, which is the other half of the ragged look. */
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 12px;
  align-items: stretch;
}
.chartbox { display: flex; flex-direction: column; min-width: 0; }
/* Reserve two lines so one- and two-line titles start their plots level. */
.chartbox h3 { margin: 0 0 10px; min-height: 2.6em; }
/* The plot centres inside a fixed minimum, so a card holding "no data yet" is
   exactly as tall as the chart beside it. */
.chartbox .plot {
  flex: 1; display: flex; align-items: center; justify-content: center;
  min-height: 188px; min-width: 0;
}
.chartbox .plot > * { width: 100%; }
```

**Empty states are part of the layout.** Render "No data yet" as a centred,
muted line inside the same `.plot` box — never as a bare paragraph that
collapses the card.

**Prove it.** Don't eyeball this either — measure:

```js
const geo = await page.$$eval('.chartbox', bs => bs.map(b => {
  const r = b.getBoundingClientRect(), p = b.querySelector('.plot').getBoundingClientRect();
  return { cardH: Math.round(r.height), plotTop: Math.round(p.top - r.top),
           plotH: Math.round(p.height) };
}));
// Every entry must be identical. Print the distinct values and check it is one.
```

---

## 2. Pick the form by the data's job

| The reader must… | Use | Not |
|---|---|---|
| Read one current value | stat tile / hero number | a one-bar bar chart |
| Read one ratio against a limit | **meter** (value + track) | a two-slice pie |
| Compare magnitude across items | bars; **horizontal** when labels are long | a donut |
| See a distribution over an **ordered** scale (time bands, tiers, age groups) | columns on a **single-hue ordinal ramp** | a multi-hue donut |
| See part-to-whole, ≤6 parts | **stacked share bar**, total as hero number | several pies |
| See a trend | line; area for a single series | bars over time |
| Compare > ~7 classes | a table | more colours |

Three swaps that almost always apply to an existing dashboard:

- **A two-slice donut is a stat tile in a costume.** Replace with a meter: big
  percentage, a track, and a one-line footnote naming the remainder
  ("6 centres still to report today").
- **Ordered bands drawn as a donut in N unrelated hues.** They are one axis,
  not N identities. Columns on a single-hue ramp; the shape is the point.
- **A donut per metric.** Six rings on one screen is one idea repeated six
  times. Keep at most one, and give the others meters, stacks and bars.

---

## 3. Colour — the part people get wrong

### One series, one colour

Colouring each bar of a *single* series differently encodes height twice and
spends the only free channel saying nothing. Give the series one colour and
pass it once. Per-bar hues are only correct when the bars are genuinely
different entities.

### Four colour jobs, four rules

- **Categorical (identity):** a fixed hue order, assigned by slot, **never
  cycled or generated**. Past 8, fold the tail into "Other" or facet.
- **Sequential / ordinal (magnitude, rank):** ONE hue, light→dark. Never a
  rainbow.
- **Diverging (polarity):** two hues that read as opposite + a neutral **grey**
  midpoint. Never a hue at the midpoint; never two cool hues as the poles.
- **Status (good / warning / bad):** a reserved set, never reused as "series 4",
  and always paired with an icon or label so colour never carries meaning alone.

### Validate — do not reason about it

Run the numbers on every categorical palette, against **your own surface**, in
**both themes**. The gates:

| Check | Threshold |
|---|---|
| Lightness band | every slot inside the band for that surface |
| Chroma floor | ≥ 0.1 — below this a slot reads grey |
| CVD separation (adjacent pairs) | ΔE ≥ 8 (OKLab ×100); 6–8 only *with* direct labels |
| Normal-vision floor (adjacent pairs) | ΔE ≥ 15 — **hard fail** below |
| Contrast vs surface | ≥ 3:1, or ship visible labels / a table view |

The normal-vision floor is the one that catches real palettes. In this
project's original palette, red and orange sat **ΔE 7.8** apart — not merely
colourblind-unsafe, but hard for *anyone* to tell apart — and one slot was
below the chroma floor, rendering grey. Both had shipped.

When a check fails, re-order the slots first (adjacency is what's measured) and
only re-step the hues if re-ordering can't clear it.

### Dark mode is a second palette, not an inversion

Do **not** reuse light-mode series colours on a dark card. Validate them
against the dark surface and you will usually find slots outside the lightness
band and some under 3:1. Pick dark steps of the same hues and validate them as
a set.

Wire both as **CSS custom properties**, so a theme toggle recolours every chart
with no re-render:

```css
:root      { --s1:#…; --s2:#…; /* … */ --o1:#…; /* ordinal, least→most */
             --st-ok:#…; --st-warn:#…; --st-bad:#…; --st-idle:#…;
             --ch-ink:#…; --ch-muted:#…; --ch-grid:#…; --ch-surface:#…; }
body.dark  { --s1:#…; /* the dark steps; the ordinal ramp inverts with the
                         surface — least is darkest on a dark card */ }
```

Two traps:

- **An SVG presentation attribute cannot resolve `var()`.** `stroke="var(--s1)"`
  silently fails. Use `style="stroke:var(--s1)"`. Same for `fill` and
  `stop-color`.
- **Chart ink must be tokens too.** Hardcoded `#444`/`#777`/`#999` for axis
  labels means dark mode renders them near-invisible. This is extremely common
  and nobody notices until someone uses dark mode in a meeting.

---

## 4. Gradients — the safe form

Wanted, but constrained: **a gradient must never introduce a second hue**, or
the fill starts implying a value the data doesn't hold. Use the same colour
fading toward the surface.

```js
const grad = (color, dir) => {
  const d = dir || '180deg';
  // Declared twice: a browser without color-mix() still gets the right solid
  // hue instead of no background at all.
  return 'background:linear-gradient(' + d + ',' + color + ' 0%,' + color + ' 100%);' +
         'background:linear-gradient(' + d + ',' + color + ' 0%,' +
         'color-mix(in srgb,' + color + ' 62%, transparent) 100%)';
};
```

For SVG areas, a two-stop `linearGradient` of the same hue from ~34% to 0%
opacity. Donut arcs: same hue, 100% → ~72%.

---

## 5. Mark specs (fixed, every chart)

- **Bars:** cap the **mark** at ~24px thick — but let the **band** stay wide, or
  the labels underneath will overlap each other. 4px rounded data-end, square at
  the baseline.
- **Lines:** 2px, round join and cap. End marker ≥ 8px diameter with a **2px
  ring in the surface colour** so it stays legible where it crosses anything.
- **Area fill:** the series hue at ~10–34% max, a wash and never a block.
- **Gridlines / axes:** hairline, **solid** (dashed reads as "threshold"), one
  step off the surface, recessive.
- **Separating touching marks:** a **2px gap in the surface colour**, never a
  border drawn around the mark.
- **Labels:** selective. Value on the column cap, at the bar tip, at the line's
  end — never a number on every point of a dense series. Legend always present
  for ≥2 series; **none for a single series** (the title already names it).
- **Text never wears the data colour.** Marks carry the hue; labels, values and
  legends use ink tokens. Identity comes from a swatch *beside* the text.

---

## 6. Anti-pattern checklist — check the output against this

- [ ] Dual-axis chart (two y-scales on one plot) — never; use two charts
- [ ] A colour ramp across a *single* series' bars
- [ ] Cycling or generating hues past slot 8
- [ ] A rainbow used for magnitude
- [ ] A hue at a diverging midpoint
- [ ] Status colours reused as a series colour
- [ ] A two-slice pie, or a one-bar bar chart
- [ ] A donut used to compare close values
- [ ] A number printed on every data point
- [ ] Dashed gridlines
- [ ] A border drawn around marks to separate them
- [ ] A label clipped by, or overflowing, its own mark
- [ ] A card whose fixed height cuts off the x-axis band
- [ ] Chart text in hardcoded hex (breaks dark mode)
- [ ] Colour assigned by rank, so filtering repaints the survivors

---

## 7. Finish by rendering it and looking at it

A validator checks colour, not layout. **Screenshot the result and actually
look**, then fix what you see. In this project that final pass — and only that
pass — caught:

- five long band labels overlapping into an unreadable smear (fix: short axis
  labels, full range in the tooltip);
- the last x-axis tick clipped at the `viewBox` edge (fix: anchor the first and
  last ticks `start`/`end` instead of `middle`);
- a direct label placed above a point that had run to the top of the plot, so it
  rendered outside the viewBox (fix: flip it below when there's no room above);
- a cumulative trend line sweeping up from the window's start hour when only one
  event had happened — drawing arrivals that never occurred (fix: start the path
  at the first real data point).

That last one was a **correctness** bug found by looking at a picture. Budget a
render-and-look pass; it is not optional polish.

## Deliverables

1. The chart toolkit, with each function documented by *why* its form is right.
2. The CSS: grid, card, plot box, and the HTML mark styles.
3. Palette tokens for both themes, with the validation output pasted into the
   commit message or a comment.
4. A screenshot of the grid in **both** themes, plus the measured card geometry
   showing one distinct value.
