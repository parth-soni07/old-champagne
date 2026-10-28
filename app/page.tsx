"use client";

import { memo, useEffect, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis, type MouseHandlerDataParam,
} from "recharts";
import { Scene } from "./scene";

type Metrics = {
  n: number; mae: number; rmse: number; bias: number; actual_mean: number; mape: number | null; p90_shortfall: number;
};
type Accuracy = {
  cutoff: string;
  overall: Metrics;
  by_day: (Metrics & { day: string })[];
  by_hour: (Metrics & { hour: number })[];
  by_lead: (Metrics & { lead: string; lo: number; hi: number })[];
  by_level: (Metrics & { level: string })[];
  histogram: { from: number; to: number; count: number }[];
  day_ahead_lead_h: [number, number];
};
type Point = { startTime: string; actual: number; forecast: number | null; publishTime: string | null };
type Day = { date: string; metrics: Metrics | null; points: Point[] };

/* Chart colour roles, per the dataviz method: one accent for the mark the story is about, a
 * de-emphasis grey for context, and a validated warm/cool pair (blue / orange) for the two-series
 * day chart and the diverging error histogram. validate_palette.js on #007aff,#c96a00 against the
 * card surface: CVD ΔE 31.8, normal ΔE 36.4, both >= 3:1. Literals because SVG presentation
 * attributes can't read CSS variables; they match --blue/--orange in globals.css. */
const C = { blue: "#007aff", orange: "#c96a00", muted: "#b8c1cf", grid: "rgba(0,0,0,0.06)", axis: "#55555a", ink: "#1d1d1f" };
const DEFAULT_CUTOFF = "09:00"; // same default as the API (backend/analysis.py DEFAULT_CUTOFF)
const CUTOFFS = ["07:00", DEFAULT_CUTOFF, "10:00", "11:00"];
const SEV = [2000, 3000]; // daily typical-miss thresholds (MW) for warmer calendar tiles
const DOW = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Copy is lowercase by design; unit symbols stay GW/MW because "mw" would read as milliwatts.
const gw = (mw: number, signed = false) => {
  const v = Math.round(mw / 100) / 10 || 0; // `|| 0` turns -0 into 0, so no "-0.0 GW"
  return `${signed && v > 0 ? "+" : ""}${v.toFixed(1)} GW`;
};
const pad2 = (h: number | string) => String(h).padStart(2, "0");
const ukTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const ukDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).toLowerCase();
// Calendar dates ("YYYY-MM-DD") read at noon UTC, so no viewer timezone can shift the day.
const calDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" }).toLowerCase();
const argmax = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((best, x, i) => (f(x) > f(xs[best]) ? i : best), 0);

/** Clean ticks (dataviz: round numbers, at most 5 steps) covering [lo, hi] in MW. */
function niceTicks(lo: number, hi: number): number[] {
  const step = [500, 1000, 2000, 2500, 5000, 10000].find((s) => Math.ceil(hi / s) - Math.floor(Math.min(lo, 0) / s) <= 5) ?? 10000;
  const ticks = [];
  for (let t = Math.floor(Math.min(lo, 0) / step) * step; t <= Math.ceil(hi / step) * step; t += step) ticks.push(t);
  return ticks;
}

// The data is a static snapshot, so a response never changes: cache the request per URL. Calendar
// tiles prefetch on hover/focus, so a click usually finds its day already loaded.
const responses = new Map<string, Promise<unknown>>();
function request<T>(url: string): Promise<T> {
  if (!responses.has(url)) {
    const p = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the data service returned ${r.status}.`))));
    p.catch(() => responses.delete(url)); // never cache a failure
    responses.set(url, p);
  }
  return responses.get(url) as Promise<T>;
}

/** Loads `url` (skips while null). Previous data stays on screen, flagged `stale`, while the
 *  next request is in flight (`loading`) or after it failed (`error`). */
function useApi<T>(url: string | null) {
  const [state, setState] = useState<{ url?: string; dataUrl?: string; data?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return;
    let current = true; // a newer URL wins even if this response arrives later
    request<T>(url)
      .then((data) => current && setState({ url, dataUrl: url, data }))
      .catch((e: Error) => current && setState((s) => ({ ...s, url, error: e.message })));
    return () => { current = false; };
  }, [url]);
  return {
    data: state.data,
    error: state.url === url ? state.error : undefined,
    loading: url !== null && state.url !== url,
    stale: state.dataUrl !== url,
  };
}

const reducedQuery = "(prefers-reduced-motion: reduce)";
/** Motion defaults to the OS setting (static when reduced) and the user can override it either
 *  way: the motion guide asks for a pause control on persistent animation. */
function useMotion() {
  const reduced = useSyncExternalStore(
    (cb) => { const m = matchMedia(reducedQuery); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => matchMedia(reducedQuery).matches,
    () => true, // server render: static until the client knows
  );
  const [choice, setChoice] = useState<boolean | null>(null);
  const on = choice ?? !reduced;
  return [on, () => setChoice(!on)] as const;
}

/** Exact figures as a spreadsheet: the analyst's table view. Fields are quoted when needed. */
function downloadCsv(name: string, head: string[], rows: (string | number)[][]) {
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const blob = new Blob([[head, ...rows].map((r) => r.map(cell).join(",")).join("\n")], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${name}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

/** One fixed shape for every readout: name (+ optional tag), the headline value, then up to three
 *  label/value facts in a fixed grid, so every chart's readout reads the same way. */
type Readout = { key: string; tag?: string; value: string; label: string; facts: [string, string][] };
type Scrub = { sel: number; onMove: (s: MouseHandlerDataParam) => void };

/** A chart you read by scrubbing. A persistent readout under the plot shows every figure for the
 *  selected mark: it replaces both the floating tooltip and the cramped table view. It opens on
 *  the mark the story is about (`initial`), follows pointer / touch, and arrow keys step through
 *  the marks (dataviz: keyboard focus shows the same as hover; tooltips enhance, never gate).
 *  Screen readers also get the full table, and "csv" exports exact values. */
function ChartCard({ title, subtitle, size = "", stale, unit, count, initial, readout, table, children }: {
  title: string; subtitle: ReactNode; size?: "" | "tall" | "short"; stale?: boolean; unit?: string;
  count: number; initial: number; readout: (i: number) => Readout;
  table: { name: string; head: string[]; rows: (string | number)[][] };
  children: (scrub: Scrub) => ReactNode;
}) {
  // A selection belongs to the story it started from: when new data moves the story, reset to it.
  const [pick, setPick] = useState<{ base: number; i: number } | null>(null);
  const sel = pick && pick.base === initial && pick.i < count ? pick.i : Math.min(initial, Math.max(count - 1, 0));
  const choose = (i: number) => setPick({ base: initial, i: Math.max(0, Math.min(count - 1, i)) });
  const onMove = (s: MouseHandlerDataParam) => {
    const i = Number(s?.activeTooltipIndex);
    if (Number.isInteger(i) && i >= 0 && i !== sel) choose(i);
  };
  const onKey = (e: KeyboardEvent) => {
    const next = { ArrowRight: sel + 1, ArrowLeft: sel - 1, Home: 0, End: count - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    choose(next);
  };
  return (
    <figure className="clay card" data-stale={stale}>
      <div className="card-head">
        <figcaption className="fig-head">
          <h3>{title}</h3>
          <span className="fig-note">{subtitle}</span>
        </figcaption>
        <button type="button" className="csv" onClick={() => downloadCsv(table.name, table.head, table.rows)}
          aria-label={`download ${title} as csv`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          csv
        </button>
      </div>
      <div className={`plot ${size}`} tabIndex={0} onKeyDown={onKey}
        aria-label={`${title}. chart: use the left and right arrow keys to read each value.`}>
        <div className="chart" aria-hidden="true">
          {unit && <span className="axis-unit">{unit}</span>}
          {children({ sel, onMove })}
        </div>
      </div>
      {/* Every mark's readout sits in the same grid cell and only the selected one is visible, so
          the strip is always as tall as the longest readout: scrubbing never resizes the card. */}
      <div className="readout" aria-live="polite" aria-atomic="true">
        {Array.from({ length: count }, (_, i) => {
          const r = readout(i);
          return (
            <div key={i} className="ro-item" data-on={i === sel}>
              <span className="ro-key">{r.key}</span>
              {r.tag && <span className="ro-tag">{r.tag}</span>}
              <span className="ro-main"><strong className="num">{r.value}</strong> {r.label}</span>
              <dl className="ro-facts">
                {r.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="num">{v}</dd></div>)}
              </dl>
            </div>
          );
        })}
      </div>
      {/* hidden via a wrapper: a table can't shrink below its content, so sr-only on it overflows */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead><tr>{table.head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </figure>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICONS = {
  wind: "M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8",
  up: "M7 17 17 7M9 7h8v8",
  shield: "M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z M9 12l2 2 4-4",
  pct: "M19 5 5 19M7 7h.01M17 17h.01",
  pause: "M9 5v14M15 5v14",
  play: "M7 5l12 7-12 7z",
};

/** Daily trend in the de-emphasis grey with the selected day in the accent (dataviz stat-tile
 *  contract). Stretches to the tile width; strokes stay crisp via non-scaling-stroke. */
function Sparkline({ values, mark }: { values: number[]; mark: number }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pt = (v: number, i: number) => [(i / (values.length - 1)) * 100, 26 - ((v - lo) / span) * 22] as const;
  const d = values.map((v, i) => `${i ? "L" : "M"}${pt(v, i).join(" ")}`).join(" ");
  const m = mark >= 0 ? pt(values[mark], mark) : null;
  return (
    <svg className="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke={C.muted} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {m && <path d={`M${m[0]} ${m[1]} l0 0`} stroke={C.blue} strokeWidth="7" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function Kpi({ tone, icon, label, value, note, trend, mark }: {
  tone: string; icon: keyof typeof ICONS; label: string; value: string; note: string; trend: number[]; mark: number;
}) {
  return (
    <div className={`clay kpi tone-${tone}`}>
      <div className="kpi-icon"><Icon d={ICONS[icon]} /></div>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-note">{note}</span>
      <Sparkline values={trend} mark={mark} />
    </div>
  );
}

const axisProps = { stroke: C.axis, fontSize: 12, tickLine: false, axisLine: false } as const;
const margin = { top: 28, right: 8, left: 0, bottom: 0 }; // top room for the axis-unit label
const toGw = (v: number) => `${v / 1000}`;
// Recharts tracks the pointer through its tooltip state; the readout renders it, so the tooltip draws nothing.
const pointerOnly = <Tooltip content={() => null} cursor={false} isAnimationActive={false} />;
const selectedRing = (on: boolean) => (on ? { stroke: C.ink, strokeWidth: 2 } : {});

/** Single-series column chart in the "emphasis" form: the bars the story is about in the accent,
 *  the rest in grey, a value label on a lone emphasised bar, an optional reference line, and an
 *  outline on the bar the readout is showing. */
function EmphasisBars<T extends object>({ data, x, y, emphasis, fmtX, refLine, scrub }: {
  data: T[]; x: keyof T & string; y: keyof T & string; emphasis: (d: T) => boolean;
  fmtX?: (v: number | string) => string; refLine?: { y: number; label: string }; scrub: Scrub;
}) {
  const values = data.map((d) => Number(d[y]));
  const labelled = data.filter(emphasis).length === 1; // dataviz: label selectively, never a crowd
  const ticks = niceTicks(Math.min(...values, refLine?.y ?? 0), Math.max(...values, refLine?.y ?? 0));
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={refLine ? { ...margin, right: 84 } : margin} accessibilityLayer={false} barCategoryGap="18%"
        onMouseMove={scrub.onMove} onClick={scrub.onMove} onTouchMove={scrub.onMove}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        {/* few categories: show every label; many (24 hours): let recharts thin them */}
        <XAxis dataKey={x as string} tickFormatter={fmtX} {...axisProps} interval={data.length <= 8 ? 0 : "preserveStartEnd"} />
        <YAxis {...axisProps} width={32} ticks={ticks} domain={[ticks[0], ticks.at(-1)!]} tickFormatter={toGw} />
        {pointerOnly}
        {refLine && (
          <ReferenceLine y={refLine.y} stroke={C.axis} strokeWidth={1}
            label={{ value: refLine.label, position: "right", fill: C.axis, fontSize: 12 }} />
        )}
        <Bar dataKey={y as string} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={emphasis(d) ? C.blue : C.muted} {...selectedRing(i === scrub.sel)} />)}
          <LabelList dataKey={y as string} content={(p) => {
            const i = Number(p.index);
            if (!labelled || !data[i] || !emphasis(data[i])) return null;
            return (
              <text x={Number(p.x) + Number(p.width) / 2} y={Number(p.y) - 8} textAnchor="middle" fill={C.ink} fontSize={12} fontWeight={700}>
                {gw(Number(p.value))}
              </text>
            );
          }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** The month's insight charts. Memoised: they depend only on the month's data and the cutoff, so
 *  a calendar click (which re-renders the page) does not re-render these four charts. */
const Insights = memo(function Insights({ a, cutoff, month, stale, loading }: {
  a: Accuracy; cutoff: string; month: string; stale: boolean; loading: boolean;
}) {
  // Insight inputs, all derived from the response so titles state what this cutoff shows.
  const o = a.overall;
  const peak = argmax(a.by_hour, (h) => h.p90_shortfall);
  const top = a.by_level.length - 1;
  const [daLo, daHi] = a.day_ahead_lead_h;
  const inWindow = (l: { lo: number; hi: number }) => l.hi > daLo && l.lo < daHi;
  const total = a.histogram.reduce((s, b) => s + b.count, 0);
  const hist = a.histogram.map((b, i, all) => ({
    ...b, mid: (b.from + b.to) / 2, below: all.slice(0, i + 1).reduce((s, x) => s + x.count, 0) / (total || 1),
  }));
  const histTicks = hist.length ? niceTicks(hist[0].from, hist.at(-1)!.to).filter((t) => t >= hist[0].from) : [];
  const p90Bin = Math.max(0, hist.findIndex((b) => b.from <= o.p90_shortfall && o.p90_shortfall < b.to));
  return (
      <section aria-labelledby="ins-h" aria-busy={loading}>
        <div className="section-head">
          <h2 id="ins-h">what {month} taught a buyer</h2>
          <p>error = forecast − actual. positive means the wind fell short and you bought the gap. drag across a chart to read it.</p>
        </div>
        <div className="insights" data-stale={stale}>
          <ChartCard
            size="tall"
            unit="GW"
            title={`hold ${gw(a.by_hour[peak].p90_shortfall)} at ${pad2(a.by_hour[peak].hour)}:00`}
            subtitle="backup that covers 9 in 10 hours, by hour (uk). the line is the flat month-wide figure: planning by hour buys less off-peak."
            count={a.by_hour.length}
            initial={peak}
            readout={(i) => {
              const h = a.by_hour[i];
              return { key: `${pad2(h.hour)}:00 uk`, value: gw(h.p90_shortfall), label: "covers 9 in 10 hours",
                tag: h.hour === a.by_hour[peak].hour ? "peak" : undefined,
                facts: [["vs flat", gw(h.p90_shortfall - o.p90_shortfall, true)], ["typical miss", gw(h.mae)], ["bias", gw(h.bias, true)]] };
            }}
            table={{ name: `backup-by-hour-${cutoff.replace(":", "")}`, head: ["hour (uk)", "backup for 90% cover (MW)", "typical miss (MW)", "bias (MW)"],
              rows: a.by_hour.map((h) => [`${pad2(h.hour)}:00`, Math.round(h.p90_shortfall), Math.round(h.mae), Math.round(h.bias)]) }}
          >
            {(scrub) => (
              <EmphasisBars data={a.by_hour} x="hour" y="p90_shortfall" emphasis={(h) => h.hour === a.by_hour[peak].hour}
                fmtX={pad2} refLine={{ y: o.p90_shortfall, label: `flat ${gw(o.p90_shortfall)}` }} scrub={scrub} />
            )}
          </ChartCard>

          <div className="three">
            <ChartCard
              size="short"
              unit="GW"
              title={`${a.by_level[top].level} forecasts run ${gw(a.by_level[top].bias)} high`}
              subtitle="average over-forecast, by forecast level. growing with wind fits curtailment."
              count={a.by_level.length}
              initial={top}
              readout={(i) => {
                const l = a.by_level[i];
                return { key: `${l.level} forecast`, tag: i === top ? "biggest gap" : undefined, value: gw(l.bias, true), label: "over-forecast",
                  facts: [["typical miss", gw(l.mae)], ["hours", `${l.n}`]] };
              }}
              table={{ name: `bias-by-level-${cutoff.replace(":", "")}`, head: ["forecast level", "hours", "bias (MW)", "typical miss (MW)"],
                rows: a.by_level.map((l) => [l.level, l.n, Math.round(l.bias), Math.round(l.mae)]) }}
            >
              {(scrub) => (
                <EmphasisBars data={a.by_level} x="level" y="bias" emphasis={(l) => l.level === a.by_level[top].level}
                  fmtX={(v) => String(v).replace(" GW", "")} scrub={scrub} />
              )}
            </ChartCard>

            <ChartCard
              size="short"
              unit="GW"
              title={`day-ahead lands ${Math.round(daLo)}–${Math.round(daHi)}h out`}
              subtitle="typical miss by hours ahead. blue: your day-ahead window."
              count={a.by_lead.length}
              initial={Math.max(0, a.by_lead.findIndex(inWindow))}
              readout={(i) => {
                const l = a.by_lead[i];
                return { key: `${l.lead} ahead`, tag: inWindow(l) ? "your window" : undefined, value: gw(l.mae), label: "typical miss",
                  facts: [["rmse", gw(l.rmse)], ["bias", gw(l.bias, true)], ["forecasts", l.n.toLocaleString("en-GB")]] };
              }}
              table={{ name: `miss-by-lead-${cutoff.replace(":", "")}`, head: ["made ahead by", "forecasts", "typical miss (MW)", "rmse (MW)", "bias (MW)"],
                rows: a.by_lead.map((l) => [l.lead, l.n, Math.round(l.mae), Math.round(l.rmse), Math.round(l.bias)]) }}
            >
              {(scrub) => (
                <EmphasisBars data={a.by_lead} x="lead" y="mae" emphasis={inWindow} fmtX={(v) => String(v).replace("h", "")} scrub={scrub} />
              )}
            </ChartCard>

            <ChartCard
              size="short"
              unit="hours"
              title={`9 in 10 hours stay under ${gw(o.p90_shortfall)} short`}
              subtitle={
                <span className="legend-row">
                  <span><i className="bar-key" style={{ background: C.orange }} aria-hidden="true" />shortfall you bought</span>
                  <span><i className="bar-key" style={{ background: C.blue }} aria-hidden="true" />spare wind</span>
                  <span>error in GW</span>
                </span>
              }
              count={hist.length}
              initial={p90Bin}
              readout={(i) => {
                const b = hist[i];
                return { key: `${gw(b.from, true)} to ${gw(b.to, true)}`, tag: b.from >= 0 ? "shortfall" : "spare wind", value: `${b.count}`, label: "hours",
                  facts: [["hours at or below", `${Math.round(b.below * 100)}%`], ["share of hours", `${Math.round((b.count / (total || 1)) * 100)}%`]] };
              }}
              table={{ name: `error-histogram-${cutoff.replace(":", "")}`, head: ["error from (MW)", "error to (MW)", "hours"],
                rows: hist.map((b) => [b.from, b.to, b.count]) }}
            >
              {({ sel, onMove }) => (
                <ResponsiveContainer>
                  <BarChart data={hist} margin={margin} accessibilityLayer={false} barCategoryGap={2}
                    onMouseMove={onMove} onClick={onMove} onTouchMove={onMove}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="mid" type="number" domain={[hist[0]?.from ?? 0, hist.at(-1)?.to ?? 0]} ticks={histTicks}
                      tickFormatter={toGw} {...axisProps} />
                    <YAxis width={32} allowDecimals={false} {...axisProps} />
                    {pointerOnly}
                    <ReferenceLine x={0} stroke={C.ink} strokeWidth={1} />
                    <ReferenceLine x={o.p90_shortfall} stroke={C.axis} strokeWidth={1}
                      label={{ value: "90%", position: "top", fill: C.axis, fontSize: 12 }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {hist.map((b, i) => <Cell key={b.from} fill={b.from >= 0 ? C.orange : C.blue} {...selectedRing(i === sel)} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>
        </div>
      </section>
  );
});

export default function Page() {
  const [cutoff, setCutoff] = useState(DEFAULT_CUTOFF);
  const [picked, setPicked] = useState<string | null>(null);
  const [motion, toggleMotion] = useMotion();
  const acc = useApi<Accuracy>(`/api/accuracy?cutoff=${cutoff}`);
  const a = acc.data;

  // The month comes from the data: calendar, labels and the default day all follow by_day.
  const days = a?.by_day.map((d) => d.day) ?? [];
  const date = picked ?? days[0] ?? null;
  const dayUrl = (iso: string) => `/api/day?date=${iso}&cutoff=${cutoff}`;
  const day = useApi<Day>(date && dayUrl(date));

  const o = a?.overall;
  const month = days[0] ? calDate(days[0], { month: "long", year: "numeric" }) : "the month";
  const firstWeekday = days[0] ? (new Date(`${days[0]}T12:00:00Z`).getUTCDay() + 6) % 7 : 0; // monday-first
  const byDay = new Map(a?.by_day.map((d) => [d.day, d]));
  const dayIndex = date ? days.indexOf(date) : -1;
  const trend = (k: keyof Metrics) => a?.by_day.map((d) => Number(d[k] ?? 0)) ?? [];
  // Label the day card from the data actually shown, not the pending selection.
  const shownDate = day.data?.date ?? date;
  const dayStats = day.data?.metrics;
  const points = day.data?.points ?? [];
  const published = points.find((p) => p.publishTime)?.publishTime;
  const worstPoint = argmax(points, (p) => (p.forecast == null ? -1 : Math.abs(p.forecast - p.actual)));
  const error = acc.error ?? day.error;
  // Turbine speed: the shown day's delivered wind against the windiest day of the month (0..1).
  const windiest = Math.max(0, ...(a?.by_day.map((d) => d.actual_mean) ?? []));
  const windiness = dayStats && windiest ? dayStats.actual_mean / windiest : 0.5;


  return (
    <>
      <Scene windiness={windiness} motion={motion} />
      <header className="glass">
        <div className="glass-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true"><Icon d={ICONS.wind} /></span>wind day-ahead</div>
          <div className="controls">
            <fieldset className="segmented">
              <legend>decide by (day before, uk)</legend>
              <div className="segments">
                {CUTOFFS.map((c) => (
                  <label key={c}>
                    <input type="radio" name="cutoff" value={c} checked={cutoff === c} onChange={() => setCutoff(c)} />
                    {c}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="button" className="motion-toggle" aria-pressed={!motion} onClick={toggleMotion}>
              <Icon d={motion ? ICONS.pause : ICONS.play} /><span className="toggle-label">{motion ? "pause motion" : "play motion"}</span>
            </button>
          </div>
        </div>
      </header>

      <main>
        <div className="hero">
          <span className="eyebrow">pilot · {days[0] ? month : "loading"} · gb wind</span>
          <h1>how far to trust tomorrow&rsquo;s wind.</h1>
          <p>the forecast you had at decision time, against what the wind really did. and what that gap costs you.</p>
          <p className="scene-note">the turbines behind this page spin at the selected day&rsquo;s real wind.</p>
        </div>

        {error && <div className="alert" role="alert">couldn&rsquo;t load the data. {error}</div>}

        <section aria-labelledby="kpi-h" aria-busy={acc.loading}>
          <div className="section-head">
            <h2 id="kpi-h">{month} at a glance</h2>
            <p>{o ? <>forecast as of {a.cutoff} uk, the day before · {o.n} hours. lines: each day of the month, selected day marked.</> : "loading…"}</p>
          </div>
          <div className="grid kpis" data-stale={acc.stale}>
            {o ? (
              <>
                <Kpi tone="blue" icon="wind" label="typical miss" value={gw(o.mae)} note="average error, per hour" trend={trend("mae")} mark={dayIndex} />
                <Kpi tone="orange" icon="up" label="runs high by" value={gw(o.bias, true)} note="forecast beats delivered wind" trend={trend("bias")} mark={dayIndex} />
                <Kpi tone="green" icon="shield" label="backup for 90% cover" value={gw(o.p90_shortfall)} note="covers the gap in 9 of 10 hours" trend={trend("p90_shortfall")} mark={dayIndex} />
                <Kpi tone="indigo" icon="pct" label="relative error" value={o.mape == null ? "–" : `${o.mape.toFixed(0)}%`} note={`mape · rmse ${gw(o.rmse)}`} trend={trend("mape")} mark={dayIndex} />
              </>
            ) : (
              [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)
            )}
          </div>
        </section>

        <section aria-labelledby="day-h" aria-busy={acc.loading || day.loading}>
          <div className="section-head">
            <h2 id="day-h">pick a day</h2>
            <p>each tile shows that day&rsquo;s typical miss. warmer means a bigger miss.</p>
          </div>
          <div className="explorer">
            <div className="clay" data-stale={acc.stale}>
              <h3 className="cal-title">{month}</h3>
              <div className="cal" role="group" aria-label="delivery day">
                {DOW.map((d) => <span key={d} className="cal-dow" aria-hidden="true">{d}</span>)}
                {Array.from({ length: firstWeekday }, (_, i) => <span key={`pad${i}`} />)}
                {days.map((iso) => {
                  const s = byDay.get(iso)!;
                  return (
                    <button key={iso} type="button" className="day" data-sev={SEV.filter((t) => s.mae >= t).length}
                      aria-pressed={iso === date} aria-label={`${calDate(iso, { day: "numeric", month: "long" })}, typical miss ${gw(s.mae)}`}
                      onClick={() => setPicked(iso)}
                      onPointerEnter={() => void request(dayUrl(iso)).catch(() => {})}
                      onFocus={() => void request(dayUrl(iso)).catch(() => {})}>
                      <b>{Number(iso.slice(8))}</b>
                      <span className="num">{(s.mae / 1000).toFixed(1)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="legend" aria-hidden="true">
                <span><i className="swatch" data-sev={0} />&lt; {SEV[0] / 1000} GW</span>
                <span><i className="swatch" data-sev={1} />{SEV[0] / 1000}–{SEV[1] / 1000} GW</span>
                <span><i className="swatch" data-sev={2} />≥ {SEV[1] / 1000} GW</span>
              </div>
            </div>

            <ChartCard
              size="tall"
              unit="GW"
              stale={day.stale}
              title={shownDate ? calDate(shownDate, { weekday: "long", day: "numeric", month: "long" }) : "loading…"}
              subtitle={
                <span className="chips">
                  <span className="chip"><i className="line-key" style={{ background: C.blue }} aria-hidden="true" /> actual</span>
                  <span className="chip"><i className="line-key" style={{ background: C.orange }} aria-hidden="true" /> day-ahead forecast</span>
                  {published && <span className="chip">published <strong>{ukDateTime(published)}</strong></span>}
                  {dayStats && <span className="chip">miss <strong className="num">{gw(dayStats.mae)}</strong></span>}
                  {dayStats && <span className="chip">bias <strong className="num">{gw(dayStats.bias, true)}</strong></span>}
                  {dayStats && <span className="chip">avg wind <strong className="num">{gw(dayStats.actual_mean)}</strong></span>}
                </span>
              }
              count={points.length}
              initial={worstPoint}
              readout={(i) => {
                const p = points[i];
                return p.forecast == null
                  ? { key: ukTime(p.startTime), value: gw(p.actual), label: "actual", facts: [["forecast", "hourly only"]] }
                  : { key: ukTime(p.startTime), tag: i === worstPoint ? "biggest miss" : undefined, value: gw(p.forecast - p.actual, true),
                      label: p.forecast > p.actual ? "short of forecast" : "above forecast",
                      facts: [["actual", gw(p.actual)], ["forecast", gw(p.forecast)]] };
              }}
              table={{ name: `day-${shownDate}-${cutoff.replace(":", "")}`, head: ["time (uk)", "actual (MW)", "forecast (MW)"],
                rows: points.map((p) => [ukTime(p.startTime), p.actual, p.forecast ?? ""]) }}
            >
              {({ sel, onMove }) => {
                const p = points[sel];
                return (
                  <ResponsiveContainer>
                    <ComposedChart data={points} margin={margin} accessibilityLayer={false}
                      onMouseMove={onMove} onClick={onMove} onTouchMove={onMove}>
                      <CartesianGrid stroke={C.grid} vertical={false} />
                      <XAxis dataKey="startTime" tickFormatter={ukTime} minTickGap={40} {...axisProps} />
                      <YAxis {...axisProps} width={32} tickFormatter={toGw}
                        ticks={niceTicks(0, Math.max(0, ...points.flatMap((q) => [q.actual, q.forecast ?? 0])))} />
                      {pointerOnly}
                      <Area dataKey="actual" stroke={C.blue} strokeWidth={2} fill={C.blue} fillOpacity={0.1} isAnimationActive={false} />
                      <Line dataKey="forecast" stroke={C.orange} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                      {p && <ReferenceLine x={p.startTime} stroke={C.axis} strokeWidth={1} />}
                      {p && <ReferenceDot x={p.startTime} y={p.actual} r={5} fill={C.blue} stroke="#fff" strokeWidth={2} />}
                      {p?.forecast != null && <ReferenceDot x={p.startTime} y={p.forecast} r={5} fill={C.orange} stroke="#fff" strokeWidth={2} />}
                    </ComposedChart>
                  </ResponsiveContainer>
                );
              }}
            </ChartCard>
          </div>
        </section>

        {a && <Insights a={a} cutoff={cutoff} month={month} stale={acc.stale} loading={acc.loading} />}
      </main>

      <footer>
        <p>
          data: elexon bmrs <a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream">windfor</a> (forecast)
          and <a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream">fuelhh</a> wind (actual).
        </p>
        <p>
          latest forecast = the newest windfor run published by your decision time on the day before (uk time). hourly
          forecasts, compared with the actual at the same hour.
        </p>
      </footer>
    </>
  );
}
