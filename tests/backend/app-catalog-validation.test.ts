import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";

import { parseArchiveResponse } from "../../src/server/services/app-catalog/archive";
import { normalizeSingleManifest } from "../../src/server/services/app-catalog/manifest-parsers";
import {
  CatalogSourceValidationError,
  isLikelyHtmlDocument,
  parseStructuredText,
} from "../../src/server/services/app-catalog/utils";

test("app catalog parser rejects HTML responses with a friendly error", () => {
  const html = `
    <!doctype html>
    <html>
      <head>
        <style type="text/css">
          :root { --tab-size-preference: 4; }
        </style>
      </head>
    </html>
  `;

  assert.equal(isLikelyHtmlDocument(html), true);
  assert.throws(
    () => parseStructuredText(html),
    (error) =>
      error instanceof CatalogSourceValidationError &&
      error.message.includes("raw JSON/YAML app manifest"),
  );
});

test("generic app template keeps its explicit category", () => {
  const templates = normalizeSingleManifest(
    {
      id: "beszel",
      name: "Beszel",
      desc: "Lightweight server monitoring",
      category: "Monitoring",
      image: "henrygd/beszel",
      tags: ["monitoring"],
      presentation: {
        icon: "icon.png",
        color: "#f59e0b",
        installs: 42,
        github: "https://github.com/henrygd/beszel",
        "hub-docker": "https://hub.docker.com/r/henrygd/beszel",
      },
    },
    "beszel",
    "https://raw.githubusercontent.com/DoktainerApp/templates/main/templates/beszel/template.json",
  );

  assert.equal(templates[0]?.category, "Monitoring");
  assert.equal(templates[0]?.desc, "Lightweight server monitoring");
  assert.deepEqual(templates[0]?.tags, ["monitoring"]);
  assert.deepEqual(templates[0]?.presentation, {
    icon: "https://raw.githubusercontent.com/DoktainerApp/templates/main/templates/beszel/icon.png",
    color: "#f59e0b",
    installs: 42,
    github: "https://github.com/henrygd/beszel",
    "hub-docker": "https://hub.docker.com/r/henrygd/beszel",
  });
});

test("community manifest fallback does not expose CasaOS as a user category", () => {
  const templates = normalizeSingleManifest(
    {
      name: "Community App",
      image: "example/community-app",
    },
    "community-app",
  );

  assert.equal(templates[0]?.category, "Community");
  assert.equal(templates[0]?.desc, "Community app config");
  assert.deepEqual(templates[0]?.tags, ["community"]);
});

test("app catalog parser hides raw YAML parser details", () => {
  assert.throws(
    () => parseStructuredText("name: Example\n  bad-indent: true"),
    (error) =>
      error instanceof CatalogSourceValidationError &&
      error.message.includes("could not be parsed as JSON or YAML") &&
      !error.message.includes("bad indentation"),
  );
});

test("app catalog archive resolves relative icon paths to GitHub raw URLs", async () => {
  const zip = new AdmZip();
  zip.addFile(
    "templates-main/templates/beszel/template.json",
    Buffer.from(
      JSON.stringify({
        id: "beszel",
        name: "Beszel",
        desc: "Monitoring",
        image: "henrygd/beszel",
        icon: "icon.png",
      }),
    ),
  );

  const result = await parseArchiveResponse(
    new Response(zip.toBuffer()),
    "github-archive",
    "GitHub Archive ZIP",
    "https://codeload.github.com/DoktainerApp/templates/zip/refs/heads/main",
  );

  assert.equal(
    result.templates[0]?.icon,
    "https://raw.githubusercontent.com/DoktainerApp/templates/main/templates/beszel/icon.png",
  );
});
