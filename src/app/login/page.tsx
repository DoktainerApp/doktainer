"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
} from "lucide-react";
import { auth, loadCurrentSession, setUser } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(
    null,
  );
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    totpCode: "",
  });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [awaitingTwoFactor, setAwaitingTwoFactor] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reasonParam = params.get("reason");
    setReason(reasonParam);

    if (reasonParam === "session-expired") {
      setError("The login session has expired. Please log in again.");
    } else {
      void loadCurrentSession().then((user) => {
        if (user) router.replace("/");
      });
    }

    let cancelled = false;

    const loadRegistrationStatus = async () => {
      try {
        const res = await auth.registrationStatus();
        if (cancelled) {
          return;
        }

        setRegistrationOpen(res.data.registrationOpen);
        setMode(res.data.registrationOpen ? "register" : "login");
      } catch {
        if (cancelled) {
          return;
        }

        setRegistrationOpen(false);
        setMode("login");
      }
    };

    void loadRegistrationStatus();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const resetTwoFactorStep = () => {
    setAwaitingTwoFactor(false);
    setForm((current) => ({ ...current, totpCode: "" }));
  };

  const handle = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res =
        mode === "login"
          ? await auth.login(
              form.email,
              form.password,
              awaitingTwoFactor ? form.totpCode : undefined,
            )
          : await auth.register(form.name, form.email, form.password);

      if (
        mode === "login" &&
        "requiresTwoFactor" in res &&
        res.requiresTwoFactor
      ) {
        setAwaitingTwoFactor(true);
        setError("");
        return;
      }

      if (!("user" in res)) {
        throw new Error("Authentication failed");
      }

      setUser(res.user);
      router.replace("/");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, rgba(59,130,246,0.16), transparent 32%), var(--bg-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="card animate-slide-in"
        style={{ width: "100%", maxWidth: 420, padding: 36 }}
      >
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 135,
              height: 135,
              borderRadius: 14,
              // background: "linear-gradient(135deg, #2563eb, #0ea5e9)",
              marginBottom: 14,
            }}
          >
            {/* <Server size={26} color="#fff" /> */}
            <img
              src={
                reason === "session-expired"
                  ? "/assets/images/img-chibi-forgiveness.png"
                  : "/assets/images/img-chibi-happy.png"
              }
              alt="Logo"
              width={135}
              height={135}
            />
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text-primary)",
              marginTop: -25,
            }}
          >
            {process.env.NEXT_PUBLIC_PANEL_NAME || "DOKTAINER"}
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
            {registrationOpen === null
              ? "Checking account setup"
              : mode === "login"
                ? awaitingTwoFactor
                  ? "Enter your 2FA code to access your account"
                  : "Sign in to your account"
                : "Create your account"}
          </p>
        </div>

        {error && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 16,
            }}
          >
            <AlertCircle size={15} color="#ef4444" />
            <span style={{ fontSize: 13, color: "#ef4444" }}>{error}</span>
          </div>
        )}

        {registrationOpen === null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              marginBottom: 16,
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            <Loader2 size={15} className="animate-spin" />
            <span>Checking account setup...</span>
          </div>
        )}

        {awaitingTwoFactor && (
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              borderRadius: 10,
              border: "1px solid rgba(14,165,233,0.28)",
              background: "rgba(14,165,233,0.08)",
              color: "var(--text-secondary)",
              fontSize: 13,
            }}
          >
            Two-factor authentication is enabled on this account. Please enter
            the 6-digit code from your authenticator app to proceed.
          </div>
        )}

        {registrationOpen !== null && (
          <form
            onSubmit={handle}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            {mode === "register" && !awaitingTwoFactor && (
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  Full Name
                </label>
                <input
                  type="text"
                  className="input"
                  placeholder="John Doe"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  style={{ width: "100%" }}
                />
              </div>
            )}

            {!awaitingTwoFactor && (
              <>
                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      display: "block",
                      marginBottom: 5,
                    }}
                  >
                    Email
                  </label>
                  <div style={{ position: "relative" }}>
                    <Mail
                      size={14}
                      style={{
                        position: "absolute",
                        left: 11,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "var(--text-muted)",
                      }}
                    />
                    <input
                      type="email"
                      className="input"
                      placeholder="admin@example.com"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                      required
                      style={{ width: "100%", paddingLeft: 34 }}
                    />
                  </div>
                </div>

                <div>
                  <label
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      display: "block",
                      marginBottom: 5,
                    }}
                  >
                    Password
                  </label>
                  <div style={{ position: "relative" }}>
                    <Lock
                      size={14}
                      style={{
                        position: "absolute",
                        left: 11,
                        top: "50%",
                        transform: "translateY(-50%)",
                        color: "var(--text-muted)",
                      }}
                    />
                    <input
                      type={showPw ? "text" : "password"}
                      className="input"
                      placeholder={
                        mode === "register"
                          ? "Min 8 characters"
                          : "Your password"
                      }
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                      required
                      minLength={mode === "register" ? 8 : 6}
                      style={{
                        width: "100%",
                        paddingLeft: 34,
                        paddingRight: 36,
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw(!showPw)}
                      style={{
                        position: "absolute",
                        right: 10,
                        top: "50%",
                        transform: "translateY(-50%)",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--text-muted)",
                        padding: 0,
                      }}
                    >
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              </>
            )}

            {awaitingTwoFactor && (
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    display: "block",
                    marginBottom: 5,
                  }}
                >
                  Authentication Code
                </label>
                <div style={{ position: "relative" }}>
                  <KeyRound
                    size={14}
                    style={{
                      position: "absolute",
                      left: 11,
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text-muted)",
                    }}
                  />
                  <input
                    type="text"
                    className="input"
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    value={form.totpCode}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        totpCode: e.target.value.replace(/\D/g, "").slice(0, 6),
                      })
                    }
                    required
                    style={{
                      width: "100%",
                      paddingLeft: 34,
                      letterSpacing: "0.28em",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              className={`btn btn-${mode === "login" ? "primary" : "success"} btn-sm`}
              disabled={loading || registrationOpen === null}
              style={{
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {loading && <Loader2 size={15} className="animate-spin" />}
              {mode === "login"
                ? awaitingTwoFactor
                  ? "Verify Code"
                  : "Sign In"
                : "Create Account"}
            </button>

            {awaitingTwoFactor && (
              <button
                type="button"
                onClick={resetTwoFactorStep}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Use different email or password
              </button>
            )}
          </form>
        )}
        {registrationOpen !== null && (
          <p
            style={{
              textAlign: "center",
              fontSize: 12,
              color: "var(--text-muted)",
              marginTop: 20,
            }}
          >
            {registrationOpen === null
              ? ""
              : registrationOpen
                ? "Register above - first user become Super Admin."
                : "Sign in with an existing account."}
          </p>
        )}
      </div>
    </div>
  );
}
