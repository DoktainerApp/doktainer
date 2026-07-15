"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, X } from "lucide-react";

type IssueDetailsSummaryProps = {
  label: string;
  message?: string;
  notes?: string[];
  description?: string;
};

export default function IssueDetailsSummary({
  label,
  message,
  notes,
  description = "Issue details returned by the current operation.",
}: IssueDetailsSummaryProps) {
  const [detailOpen, setDetailOpen] = useState(false);
  const issueNotes = (notes?.length ? notes : message ? [message] : []).filter(
    Boolean,
  );
  const issueCount = issueNotes.length || 1;

  return (
    <>
      <button
        type="button"
        className="server-config-component-issue-summary"
        onClick={() => setDetailOpen(true)}
      >
        <span className="server-config-component-issue-copy">
          <AlertTriangle size={13} />
          <span>
            {issueCount === 1
              ? "1 issue detected"
              : `${issueCount} issues detected`}
          </span>
        </span>
        <span className="server-config-component-issue-action">Details</span>
      </button>

      {detailOpen && typeof document !== "undefined"
        ? createPortal(
            <div className="modal-overlay server-config-issue-overlay">
              <div className="modal-shell" style={{ maxWidth: 520 }}>
                <div className="modal server-config-issue-dialog">
                <div className="server-config-issue-dialog-header">
                  <div>
                    <strong
                      style={{ color: "var(--text-primary)", fontSize: 15 }}
                    >
                      {label} Issues
                    </strong>
                    <p
                      style={{
                        marginTop: 6,
                        color: "var(--text-muted)",
                        fontSize: 12,
                        lineHeight: 1.5,
                      }}
                    >
                      {description}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetailOpen(false)}
                    aria-label="Close issue details"
                    className="server-config-issue-close"
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="server-config-issue-list">
                  {issueNotes.map((note, index) => (
                    <div
                      key={`${index}-${note}`}
                      className="server-config-issue-note"
                    >
                      {note}
                    </div>
                  ))}
                </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}


