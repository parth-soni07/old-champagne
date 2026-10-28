"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
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
const mwFmt = (mw: number) => `${Math.round(mw).toLocaleString("en-GB")} MW`;
const pad2 = (h: number | string) => String(h).padStart(2, "0");
const ukTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const ukDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }).toLowerCase();
// Calendar dates ("YYYY-MM-DD") read at noon UTC, so no viewer timezone can shift the day.
const calDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" }).toLowerCase();

/** Clean ticks (dataviz: round numbers, at most 5 steps) covering [lo, hi] in MW. */
function niceTicks(lo: number, hi: number): number[] {
  const step = [500, 1000, 2000, 2500, 5000, 10000].find((s) => Math.ceil(hi / s) - Math.floor(Math.min(lo, 0) / s) <= 5) ?? 10000;
  const ticks = [];
  for (let t = Math.floor(Math.min(lo, 0) / step) * step; t <= Math.ceil(hi / step) * step; t += step) ticks.push(t);
  return ticks;
}

/** Fetches `url` (skips while null). Previous data stays on screen, flagged `stale`, while the
 *  next request is in flight (`loading`) or after it failed (`error`). */
function useApi<T>(url: string | null) {
  const [state, setState] = useState<{ url?: string; dataUrl?: string; data?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`the data service returned ${r.status}.`))))
      .then((data: T) => setState({ url, dataUrl: url, data }))
      .catch((e: Error) => e.name !== "AbortError" && setState((s) => ({ ...s, url, error: e.message })));
    return () => ctrl.abort();
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

type TipItem = { name?: unknown; value?: unknown; color?: string };
/** Values lead, labels follow; series keyed by a short line in the series colour (dataviz). */
function ClayTooltip({ active, payload, label, fmtLabel, fmtValue = (v) => mwFmt(v) }: {
  active?: boolean; payload?: readonly TipItem[]; label?: unknown;
  fmtLabel?: (l: string) => string; fmtValue?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <span className="tip-label">{fmtLabel ? fmtLabel(String(label)) : String(label)}</span>
      {payload.filter((p) => p.value != null).map((p) => (
        <span key={String(p.name)} className="tip-row">
          <i className="tip-key" style={{ background: p.color }} aria-hidden="true" />
          <strong className="num">{fmtValue(Number(p.value))}</strong> {String(p.name)}
        </span>
      ))}
    </div>
  );
}

/** Chart container with its table twin (dataviz: every chart has a table view). The table
 *  replaces the chart in the same frame, so opening it never resizes the neighbouring cards. */
function ChartCard({ title, subtitle, head, rows, size = "", stale, unit, children }: {
  title: string; subtitle: ReactNode; head: string[]; rows: (string | number)[][]; size?: "" | "tall" | "short";
  stale?: boolean; unit?: string; children: ReactNode;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <figure className="clay card" data-stale={stale}>
      <div className="card-head">
        <figcaption className="fig-head">
          <h3>{title}</h3>
          <span className="fig-note">{subtitle}</span>
        </figcaption>
        <div className="view-toggle" role="group" aria-label={`${title}: view`}>
          {(["chart", "table"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v}</button>
          ))}
        </div>
      </div>
      <div className={`plot ${size}`}>
        {view === "chart" ? (
          <div className="chart" aria-hidden="true">
            {unit && <span className="axis-unit">{unit}</span>}
            {children}
          </div>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label={`${title}: data`}>
            <table>
              <caption className="sr-only">{title}</caption>
              <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        )}
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

/** Single-series column chart in the "emphasis" form: the bars the story is about in the accent,
 *  the rest in grey, a value label on the emphasised bars only, and an optional reference line. */
function EmphasisBars<T extends object>({ data, x, y, name, emphasis, fmtX, fmtLabel, refLine }: {
  data: T[]; x: keyof T & string; y: keyof T & string; name: string; emphasis: (d: T) => boolean;
  fmtX?: (v: number | string) => string; fmtLabel?: (l: string) => string; refLine?: { y: number; label: string };
}) {
  const values = data.map((d) => Number(d[y]));
  const labelled = data.filter(emphasis).length === 1; // dataviz: label selectively, never a crowd
  const ticks = niceTicks(Math.min(...values, refLine?.y ?? 0), Math.max(...values, refLine?.y ?? 0));
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={refLine ? { ...margin, right: 84 } : margin} accessibilityLayer={false} barCategoryGap="18%">
        <CartesianGrid stroke={C.grid} vertical={false} />
        {/* few categories: show every label; many (24 hours): let recharts thin them */}
        <XAxis dataKey={x as string} tickFormatter={fmtX} {...axisProps} interval={data.length <= 8 ? 0 : "preserveStartEnd"} />
        <YAxis {...axisProps} width={32} ticks={ticks} domain={[ticks[0], ticks.at(-1)!]} tickFormatter={toGw} />
        <Tooltip cursor={{ fill: C.grid }} content={(p) => <ClayTooltip {...p} fmtLabel={fmtLabel} />} />
        {refLine && (
          <ReferenceLine y={refLine.y} stroke={C.axis} strokeWidth={1}
            label={{ value: refLine.label, position: "right", fill: C.axis, fontSize: 12 }} />
        )}
        <Bar name={name} dataKey={y as string} maxBarSize={24} radius={[4, 4, 0, 0]} activeBar={{ fillOpacity: 0.8 }}>
          {data.map((d, i) => <Cell key={i} fill={emphasis(d) ? C.blue : C.muted} />)}
          <LabelList dataKey={y as string} content={(p) => {
            const i = Number(p.index);
            if (!labelled || !data[i] || !emphasis(data[i])) return null;
            return (
              <text x={Number(p.x) + Number(p.width) / 2} y={Number(p.y) - 6} textAnchor="middle" fill={C.ink} fontSize={12} fontWeight={700}>
                {gw(Number(p.value))}
              </text>
            );
          }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Page() {
  const [cutoff, setCutoff] = useState(DEFAULT_CUTOFF);
  const [picked, setPicked] = useState<string | null>(null);
  const [motion, toggleMotion] = useMotion();
  const acc = useApi<Accuracy>(`/api/accuracy?cutoff=${cutoff}`);
  const a = acc.data;

  // The month comes from the data: calendar, labels and the default day all follow by_day.
  const days = a?.by_day.map((d) => d.day) ?? [];
  const date = picked ?? days[0] ?? null;
  const day = useApi<Day>(date && `/api/day?date=${date}&cutoff=${cutoff}`);

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
  const error = acc.error ?? day.error;
  // Turbine speed: the shown day's delivered wind against the windiest day of the month (0..1).
  const windiest = Math.max(0, ...(a?.by_day.map((d) => d.actual_mean) ?? []));
  const windiness = dayStats && windiest ? dayStats.actual_mean / windiest : 0.5;

  // Insight inputs, all derived from the response so titles state what this cutoff shows.
  const peak = a?.by_hour.length ? a.by_hour.reduce((m, h) => (h.p90_shortfall > m.p90_shortfall ? h : m)) : undefined;
  const topLevel = a?.by_level.at(-1);
  const [daLo, daHi] = a?.day_ahead_lead_h ?? [0, 0];
  const inWindow = (l: { lo: number; hi: number }) => l.hi > daLo && l.lo < daHi;
  const hist = a?.histogram.map((b) => ({ ...b, mid: (b.from + b.to) / 2 })) ?? [];
  const histTicks = hist.length ? niceTicks(hist[0].from, hist.at(-1)!.to).filter((t) => t >= hist[0].from) : [];
  const bins = new Map(hist.map((b) => [String(b.mid), b]));

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
                      onClick={() => setPicked(iso)}>
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
              head={["time (uk)", "actual (MW)", "forecast (MW)"]}
              rows={points.map((p) => [ukTime(p.startTime), p.actual, p.forecast ?? "–"])}
            >
              <ResponsiveContainer>
                <ComposedChart data={points} margin={margin} accessibilityLayer={false}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="startTime" tickFormatter={ukTime} minTickGap={40} {...axisProps} />
                  <YAxis {...axisProps} width={32} tickFormatter={toGw}
                    ticks={niceTicks(0, Math.max(0, ...points.flatMap((p) => [p.actual, p.forecast ?? 0])))} />
                  <Tooltip cursor={{ stroke: C.axis, strokeWidth: 1 }} content={(p) => <ClayTooltip {...p} fmtLabel={ukTime} />} />
                  <Area name="actual" dataKey="actual" stroke={C.blue} strokeWidth={2} fill={C.blue} fillOpacity={0.1} />
                  <Line name="day-ahead forecast" dataKey="forecast" stroke={C.orange} strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </section>

        {a && (
          <section aria-labelledby="ins-h" aria-busy={acc.loading}>
            <div className="section-head">
              <h2 id="ins-h">what {month} taught a buyer</h2>
              <p>error = forecast − actual. positive means the wind fell short and you bought the gap.</p>
            </div>
            <div className="insights" data-stale={acc.stale}>
              {peak && o && (
                <ChartCard
                  size="tall"
                  unit="GW"
                  title={`hold ${gw(peak.p90_shortfall)} at ${pad2(peak.hour)}:00`}
                  subtitle="backup that covers 9 in 10 hours, by hour (uk). the line is the flat month-wide figure: planning by hour buys less off-peak."
                  head={["hour (uk)", "backup for 90% cover (MW)", "typical miss (MW)", "bias (MW)"]}
                  rows={a.by_hour.map((h) => [`${pad2(h.hour)}:00`, Math.round(h.p90_shortfall), Math.round(h.mae), Math.round(h.bias)])}
                >
                  <EmphasisBars data={a.by_hour} x="hour" y="p90_shortfall" name="backup for 90% cover"
                    emphasis={(h) => h.hour === peak.hour} fmtX={pad2} fmtLabel={(l) => `${pad2(l)}:00 uk`}
                    refLine={{ y: o.p90_shortfall, label: `flat ${gw(o.p90_shortfall)}` }} />
                </ChartCard>
              )}

              <div className="three">
                {topLevel && (
                  <ChartCard
                    size="short"
                    unit="GW"
                    title={`${topLevel.level} forecasts run ${gw(topLevel.bias)} high`}
                    subtitle="average over-forecast, by forecast level (GW). growing with wind fits curtailment."
                    head={["forecast level", "hours", "bias (MW)", "typical miss (MW)"]}
                    rows={a.by_level.map((l) => [l.level, l.n, Math.round(l.bias), Math.round(l.mae)])}
                  >
                    <EmphasisBars data={a.by_level} x="level" y="bias" name="average over-forecast"
                      emphasis={(l) => l.level === topLevel.level} fmtX={(v) => String(v).replace(" GW", "")} />
                  </ChartCard>
                )}

                <ChartCard
                  size="short"
                  unit="GW"
                  title={`day-ahead lands ${Math.round(daLo)}–${Math.round(daHi)}h out`}
                  subtitle="typical miss by hours ahead. blue: your day-ahead window."
                  head={["made ahead by", "forecasts", "typical miss (MW)", "rmse (MW)", "bias (MW)"]}
                  rows={a.by_lead.map((l) => [l.lead, l.n, Math.round(l.mae), Math.round(l.rmse), Math.round(l.bias)])}
                >
                  <EmphasisBars data={a.by_lead} x="lead" y="mae" name="typical miss" emphasis={inWindow}
                    fmtX={(v) => String(v).replace("h", "")} fmtLabel={(l) => `${l} ahead`} />
                </ChartCard>

                {o && (
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
                    head={["error range (MW)", "hours"]}
                    rows={a.histogram.filter((b) => b.count).map((b) => [`${b.from.toLocaleString("en-GB")} to ${b.to.toLocaleString("en-GB")}`, b.count])}
                  >
                    <ResponsiveContainer>
                      <BarChart data={hist} margin={margin} accessibilityLayer={false} barCategoryGap={2}>
                        <CartesianGrid stroke={C.grid} vertical={false} />
                        <XAxis dataKey="mid" type="number" domain={[hist[0]?.from ?? 0, hist.at(-1)?.to ?? 0]} ticks={histTicks}
                          tickFormatter={toGw} {...axisProps} />
                        <YAxis width={32} allowDecimals={false} {...axisProps} />
                        <Tooltip cursor={{ fill: C.grid }} content={(p) => (
                          <ClayTooltip {...p} fmtValue={(v) => `${v} hours`}
                            fmtLabel={(l) => { const b = bins.get(l); return b ? `${gw(b.from, true)} to ${gw(b.to, true)}` : l; }} />
                        )} />
                        <ReferenceLine x={0} stroke={C.ink} strokeWidth={1} />
                        <ReferenceLine x={o.p90_shortfall} stroke={C.axis} strokeWidth={1}
                          label={{ value: "90%", position: "top", fill: C.axis, fontSize: 12 }} />
                        <Bar name="hours" dataKey="count" radius={[4, 4, 0, 0]} activeBar={{ fillOpacity: 0.8 }}>
                          {hist.map((b) => <Cell key={b.from} fill={b.from >= 0 ? C.orange : C.blue} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                )}
              </div>
            </div>
          </section>
        )}
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
