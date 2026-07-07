import { CatalogSourceOption } from "./types";

export const CATALOG_SOURCE_OPTIONS: CatalogSourceOption[] = [
  {
    id: "local",
    label: "Built-in Catalog",
    description: "Use the local catalog bundled with this backend.",
    requiresUrl: false,
  },
  {
    id: "auto-detect",
    label: "Custom Source",
    description:
      "Paste any supported manifest or ZIP app store URL and let the backend detect the parser automatically.",
    requiresUrl: true,
    placeholder:
      "https://github.com/DoktainerApp/templates/archive/refs/heads/main.zip",
    exampleUrl:
      "https://github.com/DoktainerApp/templates/archive/refs/heads/main.zip",
  },
  // {
  //   id: "auto-detect",
  //   label: "Custom Source",
  //   description:
  //     "Paste a remote URL and let the backend detect whether it is a manifest, compose/config file, or ZIP app store archive.",
  //   requiresUrl: true,
  //   placeholder:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  //   exampleUrl: "https://casaos-appstore.paodayag.dev/linuxserver.zip",
  // },
  // {
  //   id: "manifest-url",
  //   label: "Manifest URL",
  //   description:
  //     "Fetch app entries from a remote JSON, YAML, CasaOS config, compose, or Umbrel manifest URL.",
  //   requiresUrl: true,
  //   placeholder: "https://example.com/apps.json",
  //   exampleUrl:
  //     "https://raw.githubusercontent.com/bigbeartechworld/big-bear-casaos/master/Apps/2fauth/config.json",
  // },
  // {
  //   id: "github-archive",
  //   label: "GitHub Archive ZIP",
  //   description:
  //     "Download a GitHub archive ZIP and scan CasaOS app folders, config.json, docker-compose.yml, JSON, or YAML manifests.",
  //   requiresUrl: true,
  //   placeholder:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  //   exampleUrl:
  //     "https://github.com/bigbeartechworld/big-bear-casaos/archive/refs/heads/master.zip",
  // },
];
