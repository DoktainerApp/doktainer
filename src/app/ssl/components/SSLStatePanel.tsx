import { Globe, Loader2, Lock } from "lucide-react";
import { SSLTabKey } from "@/app/ssl/components/ssl-utils";

interface SSLStatePanelProps {
  mode: "loading" | "empty" | "no-results";
  activeTab: SSLTabKey;
  selectedServerId: string;
}

export default function SSLStatePanel({
  mode,
  activeTab,
  selectedServerId,
}: SSLStatePanelProps) {
  if (mode === "loading") {
    return (
      <div className="card" style={{ padding: 42, textAlign: "center" }}>
        <Loader2
          size={24}
          className="animate-spin"
          style={{ color: "var(--accent)", margin: "0 auto 10px" }}
        />
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          {activeTab === "certs"
            ? "Loading certificates..."
            : "Loading domains waiting for SSL..."}
        </p>
      </div>
    );
  }

  if (mode === "no-results") {
    const Icon = activeTab === "certs" ? Lock : Globe;

    return (
      <div className="card" style={{ padding: 42, textAlign: "center" }}>
        <Icon
          size={34}
          style={{
            color: "var(--text-muted)",
            margin: "0 auto 10px",
            opacity: 0.4,
          }}
        />
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          {activeTab === "certs"
            ? "No SSL certificates match your search."
            : "No domains waiting for SSL match your search."}
        </p>
      </div>
    );
  }

  return activeTab === "domains" ? (
    <div className="card" style={{ padding: 42, textAlign: "center" }}>
      <Globe
        size={34}
        style={{
          color: "var(--text-muted)",
          margin: "0 auto 10px",
          opacity: 0.4,
        }}
      />
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
        {selectedServerId
          ? "All discovered domains on this server already have SSL certificates."
          : "No discovered domains are waiting for SSL issuance."}
      </p>
    </div>
  ) : (
    <div className="card" style={{ padding: 42, textAlign: "center" }}>
      <Lock
        size={34}
        style={{
          color: "var(--text-muted)",
          margin: "0 auto 10px",
          opacity: 0.4,
        }}
      />
      <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
        {selectedServerId
          ? "No SSL certificates found for the selected server."
          : "No SSL certificates found in database."}
      </p>
    </div>
  );
}
