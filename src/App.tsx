import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, Tooltip, XAxis, YAxis } from "recharts";

type Point = { startTime: string; actual: number; forecast: number | null; publishTime: string | null };
type Metrics = { n: number; mae: number; rmse: number; bias: number; mape: number; p90_shortfall: number };
type Accuracy = {
  overall: Metrics;
  by_hour: (Metrics & { hour: number })[];
  by_lead: (Metrics & { lead: string })[];
};

const get = <T,>(path: string): Promise<T> =>
  fetch(path).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${path}`))));
const mw = (v: number) => `${Math.round(v).toLocaleString()} MW`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

export default function App() {
  const [date, setDate] = useState("2026-01-15");
  const [cutoff, setCutoff] = useState("09:00");
  const [day, setDay] = useState<Point[]>([]);
  const [acc, setAcc] = useState<Accuracy | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    get<Point[]>(`/api/day?date=${date}&cutoff=${cutoff}`).then(setDay, (e) => setError(String(e)));
  }, [date, cutoff]);
  useEffect(() => {
    get<Accuracy>(`/api/accuracy?cutoff=${cutoff}`).then(setAcc, (e) => setError(String(e)));
  }, [cutoff]);

  const published = day.find((p) => p.publishTime)?.publishTime;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16, fontFamily: "system-ui" }}>
      <h1>UK wind: day-ahead forecast vs actual</h1>
      {error && <p role="alert">{error}</p>}
      <label>
        Delivery day <input type="date" min="2026-01-01" max="2026-01-31" value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)} />
      </label>{" "}
      <label>
        Decision cutoff (D-1, UK) <input type="time" value={cutoff} onChange={(e) => e.target.value && setCutoff(e.target.value)} />
      </label>
      {published && <p>Latest forecast available at cutoff: published {new Date(published).toLocaleString("en-GB", { timeZone: "Europe/London" })}</p>}

      <LineChart width={900} height={300} data={day}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="startTime" tickFormatter={hhmm} />
        <YAxis unit=" MW" width={90} />
        <Tooltip labelFormatter={hhmm} formatter={(v: number) => mw(v)} />
        <Legend />
        <Line dataKey="actual" stroke="#2563eb" dot={false} />
        <Line dataKey="forecast" stroke="#16a34a" dot={false} connectNulls />
      </LineChart>

      {acc && (
        <>
          <h2>January 2026 day-ahead accuracy</h2>
          <p>
            MAE {mw(acc.overall.mae)} · RMSE {mw(acc.overall.rmse)} · bias {mw(acc.overall.bias)} · MAPE{" "}
            {acc.overall.mape.toFixed(1)}% · P90 shortfall {mw(acc.overall.p90_shortfall)}
          </p>
          <h3>MAE by hour of day</h3>
          <BarChart width={900} height={220} data={acc.by_hour}>
            <XAxis dataKey="hour" />
            <YAxis width={90} />
            <Tooltip formatter={(v: number) => mw(v)} />
            <Bar dataKey="mae" fill="#2563eb" />
          </BarChart>
          <h3>MAE by forecast lead time (all forecasts)</h3>
          <BarChart width={900} height={220} data={acc.by_lead}>
            <XAxis dataKey="lead" />
            <YAxis width={90} />
            <Tooltip formatter={(v: number) => mw(v)} />
            <Bar dataKey="mae" fill="#16a34a" />
          </BarChart>
        </>
      )}
    </main>
  );
}
