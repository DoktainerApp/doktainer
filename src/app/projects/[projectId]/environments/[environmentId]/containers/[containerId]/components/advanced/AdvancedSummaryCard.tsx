import type { AdvancedSummary } from "../../types/app-detail-types";

const toneColor: Record<AdvancedSummary["tone"], string> = {
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  purple: "var(--accent-purple)",
  amber: "var(--accent-yellow)",
  cyan: "var(--accent-cyan)",
};

interface AdvancedSummaryCardProps {
  item: AdvancedSummary;
}

export default function AdvancedSummaryCard({
  item,
}: AdvancedSummaryCardProps) {
  return (
    <section
      className="card"
      style={{
        padding: 14,
        minHeight: 104,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "var(--bg-card)",
      }}
    >
      <p
        style={{
          margin: 0,
          color: "var(--text-muted)",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {item.label}
      </p>
      <strong
        style={{
          color: "var(--text-primary)",
          fontSize: 20,
          lineHeight: 1.1,
        }}
      >
        {item.value}
      </strong>
      <span style={{ color: toneColor[item.tone], fontSize: 11 }}>
        {item.subvalue}
      </span>
    </section>
  );
}
