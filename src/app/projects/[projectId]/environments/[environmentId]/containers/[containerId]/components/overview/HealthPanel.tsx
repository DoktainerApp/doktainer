import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";
import type { HealthSummary } from "../../types/app-detail-types";
import InfoRows from "./InfoRows";
import PanelShell from "./PanelShell";

interface HealthPanelProps {
  health: HealthSummary;
}

export default function HealthPanel({ health }: HealthPanelProps) {
  const normalizedStatus = health.status.toLowerCase();
  const isHealthy = normalizedStatus === "healthy";
  const isWarning =
    normalizedStatus === "unhealthy" || normalizedStatus === "starting";
  const StatusIcon = isHealthy
    ? CheckCircle2
    : isWarning
      ? AlertTriangle
      : CircleHelp;

  return (
    <PanelShell title="Health">
      <InfoRows
        rows={[
          {
            label: "Status",
            value: (
              <span
                style={{
                  color: isHealthy
                    ? "var(--accent-green)"
                    : isWarning
                      ? "var(--accent-amber)"
                      : "var(--text-muted)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                <StatusIcon size={13} />
                {health.status}
              </span>
            ),
          },
          { label: "Response Time", value: health.responseTime },
          { label: "HTTP Status", value: health.httpStatus },
          { label: "Last Check", value: health.lastCheck },
        ]}
      />
      {/* <button
        type="button"
        className="btn btn-ghost"
        style={{ width: "100%", marginTop: 13, fontSize: 12 }}
      >
        View Health Check
      </button> */}
    </PanelShell>
  );
}
