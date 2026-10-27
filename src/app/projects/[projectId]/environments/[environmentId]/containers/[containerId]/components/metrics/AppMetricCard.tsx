"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppMetric } from "../../types/app-detail-types";
import type { MetricSample } from "../../data/metric-history";
import { blendCurves, metricCurve, previewCurve } from "../../data/metric-curve";

const charts: Record<string, { key: keyof MetricSample; color: string; label: string }> = {
  "CPU Usage": { key: "cpu", color: "#3b82f6", label: "CPU (%)" },
  "Memory Usage": { key: "memory", color: "#06b6d4", label: "Memory (%)" },
  "Network In / Out": { key: "networkTotal", color: "#8b5cf6", label: "Network total (bytes, cumulative)" },
  "Block I/O": { key: "ioTotal", color: "#8b5cf6", label: "Block I/O total (bytes, cumulative)" },
  "Processes": { key: "processes", color: "#10b981", label: "Processes" },
};

function MetricCurve({ samples, chart }: { samples: MetricSample[]; chart: (typeof charts)[string] }) {
  const actual = useMemo(() => metricCurve(samples, chart.key), [samples, chart.key]);
  const target = actual ?? previewCurve;
  const currentRef = useRef(previewCurve);
  const [view, setView] = useState({ points: previewCurve, isActual: false });

  useEffect(() => {
    const startPoints = currentRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let startTime: number | null = null;
    const step = (time: number) => {
      startTime ??= time;
      const progress = reduceMotion ? 1 : Math.min(1, (time - startTime) / 800);
      const eased = 1 - (1 - progress) ** 3;
      const points = blendCurves(startPoints, target, eased);
      currentRef.current = points;
      setView({ points, isActual: progress === 1 && actual !== null });
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [actual, target]);

  const line = view.points.map((y, index) => `${index === 0 ? "M" : "L"}${(index * 180 / (view.points.length - 1)).toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return (
    <div style={{ position: "relative", width: "100%", height: 44, marginTop: 8 }} role="img" aria-label={view.isActual ? `${chart.label}, session samples` : `${chart.label}, preview awaiting samples`}>
      <svg viewBox="0 0 180 42" preserveAspectRatio="none" aria-hidden="true" style={{ width: "100%", height: 42, display: "block" }}>
        <path d={`${line} L180 42 L0 42 Z`} fill={chart.color} opacity="0.11" />
        <path d={line} fill="none" stroke={chart.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export default function AppMetricCard({ metric, samples }: { metric: AppMetric; samples: MetricSample[] }) {
  const chart = charts[metric.label];
  return (
    <article className="card" style={{ padding: 14, minWidth: 0, background: "var(--bg-card)" }}>
      <p style={{ color: "var(--text-secondary)", fontSize: 11, fontWeight: 700 }}>{metric.label}</p>
      <strong style={{ display: "block", color: "var(--text-primary)", fontSize: 20, lineHeight: 1.2, marginTop: 4, overflowWrap: "anywhere" }}>{metric.value}</strong>
      {chart ? <MetricCurve samples={samples} chart={chart} /> : null}
      <p style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 4 }}>{metric.subvalue}</p>
    </article>
  );
}
