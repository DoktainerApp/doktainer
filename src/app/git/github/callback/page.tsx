"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { gitProvidersApi, redirectToLogin } from "@/lib/api";
import { decodeGithubManifestState } from "@/lib/github-manifest-state";

export default function GithubCallbackPage() {
  const router = useRouter();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current || typeof window === "undefined") {
      return;
    }

    handledRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const returnedState = params.get("state");
    const error = params.get("error");
    const errorDescription =
      params.get("error_description") || params.get("error_reason");

    const redirectWithMessage = (
      status: "success" | "error",
      message: string,
    ) => {
      const target = new URL("/git", window.location.origin);
      target.searchParams.set("callbackProvider", "github");
      target.searchParams.set("callbackStatus", status);
      target.searchParams.set("callbackMessage", message);
      router.replace(target.pathname + target.search);
    };

    const stored = decodeGithubManifestState(returnedState);

    if (error) {
      redirectWithMessage(
        "error",
        errorDescription || `GitHub returned ${error} during app creation.`,
      );
      return;
    }

    if (!code) {
      redirectWithMessage("error", "GitHub manifest callback code is missing.");
      return;
    }

    if (!stored) {
      redirectWithMessage(
        "error",
        "GitHub manifest callback state is invalid or has expired.",
      );
      return;
    }

    const complete = async () => {
      try {
        const conversionResponse = await fetch(
          "/api/providers/github/manifest/complete",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          },
        );

        if (conversionResponse.status === 401) {
          redirectToLogin("session-expired");
          return;
        }

        const conversionPayload = (await conversionResponse.json()) as {
          success?: boolean;
          data?: {
            id?: number;
            clientId?: string;
            clientSecret?: string;
            webhookSecret?: string;
            htmlUrl?: string;
            name?: string;
          };
          error?: string;
        };

        if (
          !conversionResponse.ok ||
          !conversionPayload.success ||
          !conversionPayload.data
        ) {
          throw new Error(
            conversionPayload.error || "Failed to convert GitHub App manifest.",
          );
        }

        const appName =
          conversionPayload.data.name ||
          stored?.appName ||
          `Doktainer-${new Date().toISOString().split("T")[0].replace(/-/g, "")}-${Math.random().toString(36).slice(2, 10)}`;
        const providerName = stored?.configName?.trim() || appName;

        await gitProvidersApi.create({
          provider: "github",
          name: providerName,
          enabled: true,
          appName,
          appId: String(conversionPayload.data.id || ""),
          clientId: conversionPayload.data.clientId || "",
          clientSecret: conversionPayload.data.clientSecret || "",
          webhookSecret: conversionPayload.data.webhookSecret || "",
          appUrl: conversionPayload.data.htmlUrl || "",
          installationUrl: conversionPayload.data.htmlUrl
            ? `${conversionPayload.data.htmlUrl}/installations/new`
            : "",
          providerUrl: "",
          internalUrl: "",
          accountUsername: "",
          accountEmail: "",
          namespace: "",
          organizationScoped: Boolean(stored?.organizationScoped),
          organizationName: stored?.organizationName || "",
        });

        redirectWithMessage(
          "success",
          "GitHub App created and recorded in Doktainer successfully.",
        );
      } catch (conversionError) {
        redirectWithMessage(
          "error",
          conversionError instanceof Error
            ? conversionError.message
            : "Failed to complete the GitHub App flow.",
        );
      }
    };

    void complete();
  }, [router]);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#020617",
        color: "#f8fafc",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "min(480px, 100%)",
          padding: 24,
          borderRadius: 18,
          border: "1px solid rgba(148,163,184,0.18)",
          background: "rgba(2,6,23,0.92)",
          textAlign: "center",
        }}
      >
        Finalizing GitHub App setup...
      </div>
    </main>
  );
}
