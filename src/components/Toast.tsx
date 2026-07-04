"use client";

import { AlertTriangle, CheckCircle, Info, X, XCircle } from "lucide-react";

export type ToastTone = "success" | "error" | "warning" | "info";

interface ToastProps {
  tone: ToastTone;
  title?: string;
  message: string;
  onClose?: () => void;
  duration?: number;
  showProgress?: boolean;
}

const toneConfig: Record<
  ToastTone,
  {
    title: string;
    icon: typeof CheckCircle;
  }
> = {
  success: { title: "Success", icon: CheckCircle },
  error: { title: "Error", icon: XCircle },
  warning: { title: "Warning", icon: AlertTriangle },
  info: { title: "Info", icon: Info },
};

function toneVar(tone: ToastTone, key: string) {
  return `var(--toast-${tone}-${key})`;
}

export default function Toast({
  tone,
  title,
  message,
  onClose,
  duration,
  showProgress = false,
}: ToastProps) {
  const config = toneConfig[tone];
  const Icon = config.icon;

  return (
    <>
      <div
        className="card animate-slide-in"
        style={{
          padding: "12px 14px",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          border: toneVar(tone, "border"),
          background: toneVar(tone, "bg"),
          boxShadow: "0 18px 40px rgba(2,6,23,0.35)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <Icon
          size={18}
          style={{ color: toneVar(tone, "icon"), flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              color: toneVar(tone, "title"),
              fontSize: 13,
              fontWeight: 700,
              marginBottom: 2,
            }}
          >
            {title ?? config.title}
          </p>
          <p
            style={{
              color: toneVar(tone, "message"),
              fontSize: 12,
              lineHeight: 1.45,
            }}
          >
            {message}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: toneVar(tone, "close"),
              padding: 0,
              flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        )}
        {showProgress && duration && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: 3,
              background: "rgba(255,255,255,0.08)",
            }}
          >
            <div
              style={{
                height: "100%",
                width: "100%",
                background: toneVar(tone, "icon"),
                transformOrigin: "left center",
                animation: `toast-progress-shrink ${duration}ms linear forwards`,
              }}
            />
          </div>
        )}
      </div>
      <style jsx>{`
        @keyframes toast-progress-shrink {
          from {
            transform: scaleX(1);
          }

          to {
            transform: scaleX(0);
          }
        }
      `}</style>
    </>
  );
}
