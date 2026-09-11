"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Lock,
  Mail,
  Shield,
  User,
} from "lucide-react";
import { auth, setUser, UserRole } from "@/lib/api";

function roleLabel(role: UserRole) {
  switch (role) {
    case "SUPER_ADMIN":
      return "Super Admin";
    case "OPERATOR":
      return "Operator";
    case "DEVELOPER":
      return "Developer";
    case "VIEWER":
    default:
      return "Viewer";
  }
}

export default function InvitationPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = Array.isArray(params?.token) ? params.token[0] : params?.token;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [invitation, setInvitation] = useState<{
    email: string;
    name: string;
    role: UserRole;
    allServersAccess: boolean;
    serverIds: string[];
    expiresAt: string;
  } | null>(null);
  const [form, setForm] = useState({
    name: "",
    password: "",
    confirmPassword: "",
  });

  useEffect(() => {
    if (!token) {
      setError("Invitation token is missing.");
      setLoading(false);
      return;
    }

    const run = async () => {
      try {
        setError("");
        const response = await auth.getInvitation(token);
        setInvitation(response.data);
        setForm((current) => ({ ...current, name: response.data.name }));
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Failed to load invitation",
        );
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [token]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;

    if (form.password !== form.confirmPassword) {
      setError("Password confirmation does not match.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const response = await auth.acceptInvitation(token, {
        name: form.name,
        password: form.password,
      });

      setUser(response.user);
      router.replace("/");
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to accept invitation",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        className="card animate-slide-in"
        style={{ width: "100%", maxWidth: 460, padding: 32 }}
      >
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "linear-gradient(135deg, #3b82f6, #6366f1)",
              marginBottom: 14,
            }}
          >
            <CheckCircle size={26} color="#fff" />
          </div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Accept Invitation
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 4 }}>
            Finish onboarding and set your password.
          </p>
        </div>

        {loading ? (
          <div
            style={{
              padding: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              color: "var(--text-muted)",
            }}
          >
            <Loader2 size={16} className="animate-spin" />
            Loading invitation...
          </div>
        ) : (
          <>
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

            {invitation && (
              <>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 10,
                    marginBottom: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: "var(--text-secondary)",
                      fontSize: 12,
                    }}
                  >
                    <Mail size={13} />
                    <span>{invitation.email}</span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: "var(--text-secondary)",
                      fontSize: 12,
                    }}
                  >
                    <User size={13} />
                    <span>{roleLabel(invitation.role)}</span>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      color: "var(--text-secondary)",
                      fontSize: 12,
                    }}
                  >
                    <Shield size={13} />
                    <span>
                      {invitation.allServersAccess
                        ? "Access to all servers"
                        : `${invitation.serverIds.length} selected server(s)`}
                    </span>
                  </div>
                </div>

                <form
                  onSubmit={handleSubmit}
                  style={{ display: "flex", flexDirection: "column", gap: 14 }}
                >
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
                      className="input"
                      value={form.name}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      required
                    />
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
                        type="password"
                        className="input"
                        placeholder="Minimum 8 characters"
                        value={form.password}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            password: event.target.value,
                          }))
                        }
                        minLength={8}
                        required
                        style={{ paddingLeft: 34 }}
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
                      Confirm Password
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
                        type="password"
                        className="input"
                        placeholder="Repeat password"
                        value={form.confirmPassword}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            confirmPassword: event.target.value,
                          }))
                        }
                        minLength={8}
                        required
                        style={{ paddingLeft: 34 }}
                      />
                    </div>
                  </div>

                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={submitting}
                  >
                    {submitting ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <CheckCircle size={13} />
                    )}
                    Accept Invitation
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
