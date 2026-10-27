import type { AppMetric } from "../../types/app-detail-types";
import type { MetricSample } from "../../data/metric-history";
import AppMetricCard from "./AppMetricCard";

interface AppMetricsGridProps {
  metrics: AppMetric[];
  samples: MetricSample[];
}

export default function AppMetricsGrid({ metrics, samples }: AppMetricsGridProps) {
  return (
    <section aria-label="Container metrics">
      <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(160px, 100%), 1fr))",
        gap: 10,
        minWidth: 0,
      }}
    >
      {metrics.map((metric) => (
        <AppMetricCard key={metric.label} metric={metric} samples={samples} />
      ))}
      </div>
    </section>
  );
}
