import { ExternalLink } from "lucide-react";
import { FieldLabel } from "@/app/settings/components/SettingsPrimitives";
import {
  type GitProviderModalBaseProps,
  getProviderMeta,
} from "./git-provider-shared";
import { markGitProviderCallbackIntent } from "@/lib/git-provider-callback-intent";

export default function GitlabProviderModal({
  draft,
  setupUrl,
  callbackUrl,
  updateDraft,
}: GitProviderModalBaseProps) {
  return (
    <>
      <section
        style={{
          display: "grid",
          gap: 14,
          padding: 20,
          borderRadius: 16,
          border: `1px solid ${getProviderMeta(draft.provider).accentBorder}`,
          background: "var(--bg-input)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* <ProviderBadge provider="gitlab" size={40} /> */}
          <img
            src="https://thesvg.org/icons/gitlab/default.svg"
            alt="GitLab"
            width={50}
            height={50}
            style={{ background: "transparent" }}
          />
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              GitLab Provider
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 4,
                lineHeight: 1.6,
              }}
            >
              Create an OAuth application in GitLab first, then paste the
              generated Application ID and Secret below.
            </div>
          </div>
        </div>
        <hr style={{ borderColor: "var(--border)" }} />

        <a
          href={setupUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => markGitProviderCallbackIntent("gitlab")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            paddingLeft: 18,
            gap: 8,
            fontSize: 12,
            color: "var(--text-primary)",
            textDecoration: "none",
            width: "fit-content",
          }}
        >
          Go to your GitLab profile settings <ExternalLink size={13} />
        </a>

        <ol
          style={{
            margin: 0,
            paddingLeft: 18,
            display: "grid",
            gap: 8,
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          <li>Navigate to Applications.</li>
          <li>
            Create a new application with the name{" "}
            <strong>{draft.appName}</strong>, redirect URI{" "}
            <strong>{callbackUrl}</strong>, and scopes <strong>api</strong>,{" "}
            <strong>read_user</strong>, and <strong>read_repository</strong>.
          </li>
          <li>
            After creating the app, copy the Application ID and Secret into
            Doktainer.
          </li>
        </ol>
      </section>

      <section
        style={{
          display: "grid",
          gap: 14,
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        }}
      >
        <div style={{ gridColumn: "1 / -1" }}>
          <FieldLabel>Name</FieldLabel>
          <input
            className="input"
            value={draft.name}
            onChange={(event) => updateDraft("name", event.target.value)}
            placeholder="Random Name eg(my-personal-account)"
          />
        </div>

        <div>
          <FieldLabel>Application Name</FieldLabel>
          <input
            className="input"
            value={draft.appName}
            onChange={(event) => updateDraft("appName", event.target.value)}
            placeholder="Doktainer"
          />
        </div>

        <div>
          <FieldLabel>GitLab URL</FieldLabel>
          <input
            className="input"
            value={draft.providerUrl}
            onChange={(event) => updateDraft("providerUrl", event.target.value)}
            placeholder="https://gitlab.com"
          />
        </div>

        <div>
          <FieldLabel>Internal URL (Optional)</FieldLabel>
          <input
            className="input"
            value={draft.internalUrl}
            onChange={(event) => updateDraft("internalUrl", event.target.value)}
            placeholder="http://gitlab:80"
          />
        </div>

        <div>
          <FieldLabel>Redirect URI</FieldLabel>
          <input className="input" value={callbackUrl} readOnly />
        </div>

        <div>
          <FieldLabel>Application ID</FieldLabel>
          <input
            className="input"
            value={draft.clientId}
            onChange={(event) => updateDraft("clientId", event.target.value)}
            placeholder="Application ID"
          />
        </div>

        <div>
          <FieldLabel>Application Secret</FieldLabel>
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
              draft.hasClientSecret ? "Secret configured" : "Application Secret"
            }
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <FieldLabel>Group Name (Optional, Comma-Separated List)</FieldLabel>
          <input
            className="input"
            value={draft.namespace}
            onChange={(event) => updateDraft("namespace", event.target.value)}
            placeholder="my-org"
          />
        </div>

        <div style={{ gridColumn: "1 / -1" }}>
          <FieldLabel>GitLab Username (Required Without Group)</FieldLabel>
          <input
            className="input"
            value={draft.accountUsername}
            onChange={(event) =>
              updateDraft("accountUsername", event.target.value)
            }
            placeholder="Your GitLab username"
          />
        </div>
      </section>
    </>
  );
}
