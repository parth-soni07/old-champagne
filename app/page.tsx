"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

type Metrics = { n: number; mae: number; rmse: number; bias: number; mape: number; p90_shortfall: number };
type Accuracy = {
  cutoff: string;
  overall: Metrics;
  by_day: (Metrics & { day: string })[];
  by_hour: (Metrics & { hour: number })[];
  by_lead: (Metrics & { lead: string })[];
  by_level: (Metrics & { level: string })[];
  histogram: { from: number; to: number; count: number }[];
};
type Point = { startTime: string; actual: number; forecast: number | null; publishTime: string | null };
type Day = { date: string; metrics: Metrics | null; points: Point[] };

// Mirrors the CSS tokens; SVG presentation attributes need literal colours.
const C = { blue: "#007aff", orange: "#ff9500", green: "#34c759", indigo: "#5856d6", grid: "rgba(0,0,0,0.06)", axis: "#5e5e63" };
const CUTOFFS = ["07:00", "09:00", "10:00", "11:00"];
const SEV = [2000, 3000]; // daily typical-miss thresholds (MW) for warmer calendar tiles
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const JAN1_OFFSET = (new Date(Date.UTC(2026, 0, 1)).getUTCDay() + 6) % 7; // Monday-first grid

const gw = (mw: number, signed = false) => `${signed && mw > 0 ? "+" : ""}${(mw / 1000).toFixed(1)} GW`;
const mwFmt = (mw: number) => `${Math.round(mw).toLocaleString("en-GB")} MW`;
const ukTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const ukDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

function useApi<T>(url: string) {
  const [state, setState] = useState<{ url?: string; dataUrl?: string; data?: T; error?: string }>({});
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The data service returned ${r.status}.`))))
      .then((data: T) => setState({ url, dataUrl: url, data }))
      .catch((e: Error) => e.name !== "AbortError" && setState((s) => ({ ...s, url, error: e.message })));
    return () => ctrl.abort();
  }, [url]);
  // Previous data stays on screen (dimmed via `stale`) while the next request is in flight or failed.
  return { data: state.data, error: state.url === url ? state.error : undefined, stale: state.dataUrl !== url };
}

type TipItem = { name?: unknown; value?: unknown; color?: string };
function ClayTooltip({ active, payload, label, fmtLabel, fmtValue = (v) => mwFmt(v) }: {
  active?: boolean; payload?: readonly TipItem[]; label?: unknown;
  fmtLabel?: (l: string) => string; fmtValue?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <strong>{fmtLabel ? fmtLabel(String(label)) : String(label)}</strong>
      {payload.filter((p) => p.value != null).map((p) => (
        <span key={String(p.name)} className="num">
          <span aria-hidden="true" style={{ color: p.color }}>● </span>{String(p.name)}: {fmtValue(Number(p.value))}
        </span>
      ))}
    </div>
  );
}

function ChartCard({ title, caption, head, rows, tall, children }: {
  title: string; caption: ReactNode; head: string[]; rows: (string | number)[][]; tall?: boolean; children: ReactNode;
}) {
  return (
    <figure className="clay">
      <div className="fig-head">
        <h3>{title}</h3>
        <figcaption>{caption}</figcaption>
      </div>
      <div className={tall ? "chart tall" : "chart"} aria-hidden="true">{children}</div>
      <details>
        <summary>Show data</summary>
        <div className="table-wrap" tabIndex={0} role="region" aria-label={`${title} data`}>
          <table>
            <caption className="sr-only">{title}</caption>
            <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </details>
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
};

function Kpi({ tone, icon, label, value, note }: { tone: string; icon: keyof typeof ICONS; label: string; value: string; note: string }) {
  return (
    <div className={`clay kpi tone-${tone}`}>
      <div className="kpi-icon"><Icon d={ICONS[icon]} /></div>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value num">{value}</span>
      <span className="kpi-note">{note}</span>
    </div>
  );
}

const axisProps = { stroke: C.axis, fontSize: 12, tickLine: false, axisLine: false } as const;
const gwAxis = { ...axisProps, tickFormatter: (v: number) => `${v / 1000}`, unit: " GW", width: 56 } as const;
const margin = { top: 8, right: 8, left: 0, bottom: 0 };
const pad2 = (h: number | string) => String(h).padStart(2, "0");

// recharts' default isAnimationActive="auto" already honours prefers-reduced-motion.
function GwBars({ data, x, y, name, fill, fmtX, fmtLabel }: {
  data: readonly object[]; x: string; y: string; name: string; fill: string;
  fmtX?: (v: number | string) => string; fmtLabel?: (l: string) => string;
}) {
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={margin}>
        <CartesianGrid stroke={C.grid} vertical={false} />
        <XAxis dataKey={x} tickFormatter={fmtX} {...axisProps} />
        <YAxis {...gwAxis} />
        <Tooltip cursor={{ fill: C.grid }} content={(p) => <ClayTooltip {...p} fmtLabel={fmtLabel} />} />
        <Bar name={name} dataKey={y} fill={fill} radius={[8, 8, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Page() {
  const [cutoff, setCutoff] = useState("09:00");
  const [date, setDate] = useState("2026-01-15");
  const acc = useApi<Accuracy>(`/api/accuracy?cutoff=${cutoff}`);
  const day = useApi<Day>(`/api/day?date=${date}&cutoff=${cutoff}`);

  const a = acc.data;
  const o = a?.overall;
  const byDay = new Map(a?.by_day.map((d) => [d.day, d]));
  // Label the day card from the data actually shown, not the pending selection.
  const shownDate = day.data?.date ?? date;
  const dayStats = day.data?.metrics;
  const points = day.data?.points ?? [];
  const published = points.find((p) => p.publishTime)?.publishTime;
  const bins = new Map(a?.histogram.map((b) => [String(b.from), b]));
  const worstHour = a?.by_hour.length ? a.by_hour.reduce((m, h) => (h.p90_shortfall > m.p90_shortfall ? h : m)) : undefined;
  const topLevel = a?.by_level.at(-1);
  const [nearLead, farLead] = [a?.by_lead[0], a?.by_lead.at(-1)];
  const error = acc.error ?? day.error;

  return (
    <>
      <header className="glass">
        <div className="glass-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true"><Icon d={ICONS.wind} /></span>Wind Day-Ahead</div>
          <fieldset className="segmented">
            <legend>Decide by (day before, UK)</legend>
            <div className="segments">
              {CUTOFFS.map((c) => (
                <label key={c}>
                  <input type="radio" name="cutoff" value={c} checked={cutoff === c} onChange={() => setCutoff(c)} />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </header>

      <main>
        <div className="hero">
          <span className="eyebrow">Pilot · January 2026 · GB national wind</span>
          <h1>Know how far to trust tomorrow&rsquo;s wind.</h1>
          <p>
            Here is the latest Elexon wind forecast you would have had at your day-ahead decision time, set
            against what the wind actually delivered. It also shows how much backup that error should cost you.
          </p>
        </div>

        {error && <div className="alert" role="alert">Couldn&rsquo;t load the data. {error}</div>}

        <section aria-labelledby="kpi-h" aria-busy={acc.stale}>
          <div className="section-head">
            <h2 id="kpi-h">January at a glance</h2>
            <p>{o ? <>Day-ahead forecast as available at {a.cutoff} UK on the day before, across {o.n} hours of the month.</> : "Loading…"}</p>
          </div>
          <div className="grid kpis">
            {o ? (
              <>
                <Kpi tone="blue" icon="wind" label="Typical miss" value={gw(o.mae)} note="Mean absolute error per hour" />
                <Kpi tone="orange" icon="up" label="Runs high by" value={gw(o.bias, true)} note="Forecast exceeds delivered wind on average" />
                <Kpi tone="green" icon="shield" label="Backup for 90% cover" value={gw(o.p90_shortfall)} note="Extra power that covers the shortfall in 9 of 10 hours" />
                <Kpi tone="indigo" icon="pct" label="Relative error" value={`${o.mape.toFixed(0)}%`} note={`MAPE · RMSE ${gw(o.rmse)}`} />
              </>
            ) : (
              [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)
            )}
          </div>
        </section>

        <section aria-labelledby="day-h" aria-busy={day.stale}>
          <div className="section-head">
            <h2 id="day-h">Pick a delivery day</h2>
            <p>Each tile shows that day&rsquo;s typical miss. Warmer tiles had bigger misses.</p>
          </div>
          <div className="explorer">
            <div className="clay">
              <h3 className="cal-title">January 2026</h3>
              <div className="cal" role="group" aria-label="Delivery day">
                {DOW.map((d) => <span key={d} className="cal-dow" aria-hidden="true">{d}</span>)}
                {Array.from({ length: JAN1_OFFSET }, (_, i) => <span key={`pad${i}`} />)}
                {Array.from({ length: 31 }, (_, i) => {
                  const iso = `2026-01-${pad2(i + 1)}`;
                  const s = byDay.get(iso);
                  const sev = s ? SEV.filter((t) => s.mae >= t).length : 0;
                  return (
                    <button key={iso} type="button" className="day" data-sev={sev} aria-pressed={iso === date}
                      aria-label={`${i + 1} January${s ? `, typical miss ${gw(s.mae)}` : ""}`}
                      onClick={() => setDate(iso)}>
                      <b>{i + 1}</b>
                      <span className="num">{s ? (s.mae / 1000).toFixed(1) : "–"}</span>
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
              tall
              title={new Date(`${shownDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}
              caption={
                <span className="chips">
                  <span className="chip"><span aria-hidden="true" style={{ color: C.blue }}>●</span> Actual</span>
                  <span className="chip"><span aria-hidden="true" style={{ color: C.orange }}>●</span> Day-ahead forecast</span>
                  {published && <span className="chip">Forecast published <strong>{ukDateTime(published)}</strong></span>}
                  {dayStats && <span className="chip">Typical miss <strong className="num">{gw(dayStats.mae)}</strong></span>}
                  {dayStats && <span className="chip">Bias <strong className="num">{gw(dayStats.bias, true)}</strong></span>}
                </span>
              }
              head={["Time (UK)", "Actual (MW)", "Forecast (MW)"]}
              rows={points.map((p) => [ukTime(p.startTime), p.actual, p.forecast ?? "–"])}
            >
              <ResponsiveContainer>
                <ComposedChart data={points} margin={margin}>
                  <defs>
                    <linearGradient id="actualFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.blue} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={C.blue} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="startTime" tickFormatter={ukTime} minTickGap={40} {...axisProps} />
                  <YAxis {...gwAxis} />
                  <Tooltip content={(p) => <ClayTooltip {...p} fmtLabel={ukTime} />} />
                  <Area name="Actual" dataKey="actual" stroke={C.blue} strokeWidth={2.5} fill="url(#actualFill)" />
                  <Line name="Day-ahead forecast" dataKey="forecast" stroke={C.orange} strokeWidth={2.5} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </section>

        {a && (
          <section aria-labelledby="ins-h" aria-busy={acc.stale}>
            <div className="section-head">
              <h2 id="ins-h">What January tells a buyer</h2>
              <p>Error is forecast minus actual. A positive error means wind under-delivered, so you had to buy the gap.</p>
            </div>
            <div className="grid two">
              <ChartCard
                title="Backup to hold, hour by hour"
                caption={worstHour && <>Hold most backup around <strong>{pad2(worstHour.hour)}:00</strong> UK, when covering 9 of 10 hours needs <strong className="num">{gw(worstHour.p90_shortfall)}</strong>.</>}
                head={["Hour (UK)", "P90 shortfall (MW)", "Typical miss (MW)", "Bias (MW)"]}
                rows={a.by_hour.map((h) => [`${pad2(h.hour)}:00`, Math.round(h.p90_shortfall), Math.round(h.mae), Math.round(h.bias)])}
              >
                <GwBars data={a.by_hour} x="hour" y="p90_shortfall" name="Backup for 90% cover" fill={C.green}
                  fmtX={pad2} fmtLabel={(l) => `${pad2(l)}:00 UK`} />
              </ChartCard>

              <ChartCard
                title="The windier it is, the more it over-promises"
                caption={topLevel && <>When the forecast is {topLevel.level}, wind under-delivers by <strong className="num">{gw(topLevel.bias)}</strong> on average. This fits curtailment, where turbines are turned down when the grid can&rsquo;t take their output.</>}
                head={["Forecast level", "Hours", "Bias (MW)", "Typical miss (MW)"]}
                rows={a.by_level.map((l) => [l.level, l.n, Math.round(l.bias), Math.round(l.mae)])}
              >
                <GwBars data={a.by_level} x="level" y="bias" name="Average over-forecast" fill={C.indigo} />
              </ChartCard>

              <ChartCard
                title="Fresher forecasts miss less"
                caption={nearLead && farLead && <>Typical miss grows from <strong className="num">{gw(nearLead.mae)}</strong> for forecasts made {nearLead.lead} ahead to <strong className="num">{gw(farLead.mae)}</strong> at {farLead.lead} ahead.</>}
                head={["Made ahead by", "Forecasts", "Typical miss (MW)", "RMSE (MW)", "Bias (MW)"]}
                rows={a.by_lead.map((l) => [l.lead, l.n, Math.round(l.mae), Math.round(l.rmse), Math.round(l.bias)])}
              >
                <GwBars data={a.by_lead} x="lead" y="mae" name="Typical miss" fill={C.blue} />
              </ChartCard>

              <ChartCard
                title="How big the misses get"
                caption={<>Hours by size of error. Bars right of zero (orange) are shortfalls you had to buy. Bars left of zero (green) are surplus wind.</>}
                head={["Error range (MW)", "Hours"]}
                rows={a.histogram.filter((b) => b.count).map((b) => [`${b.from.toLocaleString("en-GB")} to ${b.to.toLocaleString("en-GB")}`, b.count])}
              >
                <ResponsiveContainer>
                  <BarChart data={a.histogram} margin={margin}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="from" tickFormatter={(v: number) => `${v / 1000}`} unit=" GW" {...axisProps} />
                    <YAxis width={40} allowDecimals={false} {...axisProps} />
                    <Tooltip cursor={{ fill: C.grid }} content={(p) => (
                      <ClayTooltip {...p} fmtLabel={(l) => { const b = bins.get(l); return b ? `${gw(b.from, true)} to ${gw(b.to, true)}` : l; }} fmtValue={(v) => `${v} hours`} />
                    )} />
                    <Bar name="Hours" dataKey="count" radius={[6, 6, 0, 0]}>
                      {a.histogram.map((b) => <Cell key={b.from} fill={b.from >= 0 ? C.orange : C.green} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </section>
        )}

        <footer>
          <p>
            Data: Elexon BMRS <a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream">WINDFOR</a> (forecast)
            and <a href="https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream">FUELHH</a> fuel type WIND (actual).
          </p>
          <p>
            &ldquo;Latest forecast&rdquo; means the newest WINDFOR run published at or before your decision time on the day before delivery
            (UK time). Forecasts are hourly and are compared with the actual output at the same hour.
          </p>
        </footer>
      </main>
    </>
  );
}
