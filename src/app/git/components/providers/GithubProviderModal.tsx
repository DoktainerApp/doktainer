import { ExternalLink } from "lucide-react";
import {
  FieldLabel,
  Toggle,
} from "@/app/settings/components/SettingsPrimitives";
import {
  type GithubProviderModalProps,
  getProviderMeta,
  launchGithubManifestFlow,
} from "./git-provider-shared";
import { markGitProviderCallbackIntent } from "@/lib/git-provider-callback-intent";

export default function GithubProviderModal({
  draft,
  setupUrl,
  updateDraft,
  detailsOpen,
  setDetailsOpen,
}: GithubProviderModalProps) {
  return (
    <>
      <section
        style={{
          display: "grid",
          gap: 16,
          padding: 22,
          borderRadius: 16,
          border: `1px solid ${getProviderMeta(draft.provider).accentBorder}`,
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* <ProviderBadge provider="github" size={40} /> */}
          <img
            src="https://thesvg.org/icons/github/light.svg"
            alt="GitHub"
            width={50}
            height={50}
            style={{
              color: "var(--bg-primary)",
              background: "transparent",
              filter: "invert(1)",
            }}
          />
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              GitHub Provider
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 4,
                lineHeight: 1.6,
              }}
            >
              To integrate your GitHub account with Doktainer, create and
              install a GitHub App first. This flow only takes a few minutes.
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              Organization?
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 4,
              }}
            >
              Enable this if the GitHub App should be created under an
              organization instead of a personal account.
            </div>
          </div>
          <Toggle
            checked={draft.organizationScoped}
            onChange={() =>
              updateDraft("organizationScoped", !draft.organizationScoped)
            }
          />
        </div>

        {draft.organizationScoped ? (
          <div>
            <FieldLabel>Organization Name</FieldLabel>
            <input
              className="input"
              value={draft.organizationName}
              onChange={(event) =>
                updateDraft("organizationName", event.target.value)
              }
              placeholder="Organization name"
            />
          </div>
        ) : (
          <div>
            <FieldLabel>GitHub Username</FieldLabel>
            <input
              className="input"
              value={draft.accountUsername}
              onChange={(event) =>
                updateDraft("accountUsername", event.target.value)
              }
              placeholder="Your GitHub username"
            />
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Unsure if you already have an app?
            </div>
            <button
              type="button"
              onClick={() => setDetailsOpen((current) => !current)}
              style={{
                marginTop: 6,
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--text-secondary)",
                fontSize: 12,
              }}
            >
              {detailsOpen
                ? "Hide existing app details"
                : "I already have a GitHub App"}
            </button>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              markGitProviderCallbackIntent("github");
              if (!launchGithubManifestFlow(draft)) {
                window.location.assign(setupUrl);
              }
            }}
            disabled={!setupUrl}
          >
            <ExternalLink size={14} />
            Create GitHub App
          </button>
        </div>
      </section>

      {detailsOpen ? (
        <section
          style={{
            display: "grid",
            gap: 14,
            gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          }}
        >
          <div style={{ gridColumn: "1 / -1" }}>
            <FieldLabel>Config Name</FieldLabel>
            <input
              className="input"
              value={draft.name}
              onChange={(event) => updateDraft("name", event.target.value)}
              placeholder="GitHub App Production"
            />
          </div>

          <div>
            <FieldLabel>App Name</FieldLabel>
            <input
              className="input"
              value={draft.appName}
              onChange={(event) => updateDraft("appName", event.target.value)}
              placeholder="Doktainer-20260718-ab12cd34"
            />
          </div>

          <div>
            <FieldLabel>App ID</FieldLabel>
            <input
              className="input"
              value={draft.appId}
              onChange={(event) => updateDraft("appId", event.target.value)}
              placeholder="Paste GitHub App ID"
            />
          </div>

          <div>
            <FieldLabel>Client ID</FieldLabel>
            <input
              className="input"
              value={draft.clientId}
              onChange={(event) => updateDraft("clientId", event.target.value)}
              placeholder="Iv1..."
            />
          </div>

          <div>
            <FieldLabel>Client Secret</FieldLabel>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={draft.clientSecret}
              onChange={(event) => {
                updateDraft("clientSecret", event.target.value);
                if (event.target.value.trim()) {
                  updateDraft("hasClientSecret", true);
                }
              }}
              placeholder={
                draft.hasClientSecret
                  ? "Secret configured"
                  : "Paste client secret"
              }
            />
          </div>

          <div>
            <FieldLabel>Webhook Secret</FieldLabel>
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={draft.webhookSecret}
              onChange={(event) => {
                updateDraft("webhookSecret", event.target.value);
                if (event.target.value.trim()) {
                  updateDraft("hasWebhookSecret", true);
                }
              }}
              placeholder={
                draft.hasWebhookSecret
                  ? "Webhook secret configured"
                  : "Optional webhook secret"
              }
            />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <FieldLabel>App URL</FieldLabel>
            <input
              className="input"
              value={draft.appUrl}
              onChange={(event) => updateDraft("appUrl", event.target.value)}
              placeholder="https://github.com/apps/your-app"
            />
          </div>

          <div style={{ gridColumn: "1 / -1" }}>
            <FieldLabel>Installation URL</FieldLabel>
            <input
              className="input"
              value={draft.installationUrl}
              onChange={(event) =>
                updateDraft("installationUrl", event.target.value)
              }
              placeholder="https://github.com/apps/your-app/installations/new"
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
