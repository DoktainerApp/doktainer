"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Loader2, RocketIcon, X } from "lucide-react";
import SearchableSelect from "@/components/SearchableSelect";
import type { ProcessLogsModalState } from "@/components/ProcessLogsModal";
import type { ToastInput } from "@/lib/use-toast-manager";
import {
  containers as containersApi,
  gitProvidersApi,
  networks as networksApi,
  projectsApi,
  type ContainerDeployBody,
  type ContainerDeployMode,
  type ContainerSourceType,
  type GitBuildType,
  type GitProviderBranch,
  type GitProviderRecord,
  type ProjectRecord,
  type GitProviderRepository,
  type NetworkRecord,
  type RepositoryVisibility,
  type Server,
} from "@/lib/api";
import {
  completeDeployTimelineModal,
  createDeployTimelineUpdate,
  failDeployTimelineModal,
  openDeployTimelineModal,
  updateDeployTimelineModal,
} from "./DeployTimelineModal";

interface DeployContainerModalProps {
  serverList: Server[];
  initialServerId?: string;
  initialEnvironmentId?: string;
  lockEnvironmentSelection?: boolean;
  onClose: () => void;
  onDeployed: () => void;
  onProcessOpen?: (state: ProcessLogsModalState) => void;
  onProcessUpdate?: (state: Partial<ProcessLogsModalState>) => void;
  onToast?: (toast: ToastInput) => void;
}

type DeployChoice = Exclude<ContainerSourceType, "APP_INSTALLER"> | null;

type ComposeEnvFileDraft = {
  id: string;
  path: string;
  content: string;
};

type FormState = {
  name: string;
  serverId: string;
  environmentId: string;
  image: string;
  ports: string;
  env: string;
  networkId: string;
  restartPolicy: string;
  volumes: string;
  deployMode: ContainerDeployMode;
  buildType: GitBuildType;
  repoUrl: string;
  repoBranch: string;
  repoVisibility: RepositoryVisibility;
  accessToken: string;
  gitProviderId: string;
  buildPath: string;
  startCommand: string;
  portOverride: string;
  publishDirectory: string;
  composeContent: string;
  composeFilePath: string;
  composeEnvFiles: ComposeEnvFileDraft[];
  dockerfileContent: string;
  dockerfilePath: string;
  dockerContextPath: string;
  imageTag: string;
};

function createComposeEnvFileDraft(): ComposeEnvFileDraft {
  return {
    id: `env-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    path: "",
    content: "",
  };
}

const cardStyles = {
  textAlign: "left" as const,
  padding: 16,
  borderRadius: 12,
  border: "1px solid rgba(59,130,246,0.24)",
  background: "rgba(59,130,246,0.08)",
  color: "var(--text-primary)",
  cursor: "pointer",
  minHeight: 142,
};

function initialForm(
  serverList: Server[],
  initial?: { serverId?: string; environmentId?: string },
): FormState {
  const initialServerExists = serverList.some(
    (server) => server.id === initial?.serverId,
  );

  return {
    name: "",
    serverId: initialServerExists
      ? (initial?.serverId ?? "")
      : (serverList[0]?.id ?? ""),
    environmentId: initial?.environmentId ?? "",
    image: "",
    ports: "",
    env: "",
    networkId: "",
    restartPolicy: "unless-stopped",
    volumes: "",
    deployMode: "IMAGE",
    buildType: "NIXPACKS",
    repoUrl: "",
    repoBranch: "",
    repoVisibility: "PUBLIC",
    accessToken: "",
    gitProviderId: "",
    buildPath: "/",
    startCommand: "",
    portOverride: "",
    publishDirectory: "dist",
    composeContent:
      'services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8080:80"',
    composeFilePath: "docker-compose.yml",
    composeEnvFiles: [],
    dockerfileContent: "FROM nginx:alpine",
    dockerfilePath: "Dockerfile",
    dockerContextPath: ".",
    imageTag: "",
  };
}

function fieldLabel(label: string) {
  return (
    <label
      style={{
        fontSize: 12,
        color: "var(--text-muted)",
        display: "block",
        marginBottom: 5,
      }}
    >
      {label}
    </label>
  );
}

const gitBuildTypeOptions: Array<{
  value: GitBuildType;
  label: string;
  description: string;
}> = [
  {
    value: "NIXPACKS",
    label: "Nixpacks",
    description:
      "Auto detect runtime, build image, and run the app from the selected repository path.",
  },
  {
    value: "HEROKU_BUILDPACKS",
    label: "Heroku Buildpacks",
    description:
      "Build the repository using Heroku-style buildpacks through Cloud Native Buildpacks.",
  },
  {
    value: "PAKETO_BUILDPACKS",
    label: "Paketo Buildpacks",
    description:
      "Build the repository using Paketo builders when you want a Cloud Native Buildpacks workflow.",
  },
  {
    value: "STATIC",
    label: "Static",
    description:
      "Build the project, then serve the selected publish directory as a static site.",
  },
  {
    value: "DOCKERFILE",
    label: "Dockerfile",
    description:
      "Use an existing Dockerfile in the repository when you need a custom image build.",
  },
  {
    value: "COMPOSE",
    label: "Compose File",
    description: "Use an existing docker-compose file from the repository.",
  },
];

export default function DeployContainerModal({
  serverList,
  initialServerId,
  initialEnvironmentId,
  lockEnvironmentSelection = false,
  onClose,
  onDeployed,
  onProcessOpen,
  onProcessUpdate,
  onToast,
}: DeployContainerModalProps) {
  const router = useRouter();
  const [choice, setChoice] = useState<DeployChoice>(null);
  const [form, setForm] = useState<FormState>(() =>
    initialForm(serverList, {
      serverId: initialServerId,
      environmentId: initialEnvironmentId,
    }),
  );
  const [gitProviders, setGitProviders] = useState<GitProviderRecord[]>([]);
  const [providerRepositories, setProviderRepositories] = useState<
    GitProviderRepository[]
  >([]);
  const [providerBranches, setProviderBranches] = useState<GitProviderBranch[]>(
    [],
  );
  const [providersLoading, setProvidersLoading] = useState(false);
  const [repositoriesLoading, setRepositoriesLoading] = useState(false);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [providerDataError, setProviderDataError] = useState("");
  const [networkOptions, setNetworkOptions] = useState<NetworkRecord[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectRecord[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [networksLoading, setNetworksLoading] = useState(false);
  const [networksError, setNetworksError] = useState("");
  const envFileInputRef = useRef<HTMLInputElement | null>(null);
  const currentJobIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);
  const [uploadTargetEnvId, setUploadTargetEnvId] = useState<string | null>(
    null,
  );

  const selectedProviderRepository = useMemo(
    () =>
      providerRepositories.find(
        (repository) => repository.cloneUrl === form.repoUrl,
      ) ?? null,
    [providerRepositories, form.repoUrl],
  );

  const gitBuildType = form.buildType;
  const showGitDockerfileSettings = gitBuildType === "DOCKERFILE";
  const showGitComposeSettings = gitBuildType === "COMPOSE";
  const showStaticSettings = gitBuildType === "STATIC";
  const showRuntimeOverrideSettings =
    gitBuildType !== "COMPOSE" && gitBuildType !== "STATIC";
  const showNetworkSelector =
    choice !== null && !(choice === "MANUAL" && form.deployMode === "COMPOSE");
  const serverSelectOptions = useMemo(
    () =>
      serverList.map((server) => ({
        value: server.id,
        label: server.name,
        description: server.ip,
        keywords: `${server.name} ${server.ip}`,
      })),
    [serverList],
  );
  const availableEnvironments = useMemo(
    () =>
      projectOptions.flatMap((project) =>
        project.environments
          .filter((environment) => environment.serverId === form.serverId)
          .map((environment) => ({
            id: environment.id,
            label: `${project.name} / ${environment.name}`,
            description: `${environment.kind.toLowerCase()} on ${environment.server.name}`,
          })),
      ),
    [form.serverId, projectOptions],
  );
  const environmentSelectOptions = useMemo(
    () => [
      {
        value: "",
        label: projectsLoading
          ? "Loading environments..."
          : availableEnvironments.length > 0
            ? "No environment selected"
            : "No environment mapped to this server",
      },
      ...availableEnvironments.map((environment) => ({
        value: environment.id,
        label: environment.label,
        description: environment.description,
        keywords: `${environment.label} ${environment.description}`,
      })),
    ],
    [availableEnvironments, projectsLoading],
  );
  const networkSelectOptions = useMemo(
    () => [
      {
        value: "",
        label: networksLoading
          ? "Loading networks..."
          : "Bridge default / no explicit network",
      },
      ...networkOptions.map((network) => ({
        value: network.id,
        label: network.name,
        description: network.driver,
        keywords: `${network.name} ${network.driver} ${network.scope} ${
          network.subnet ?? ""
        } ${network.gateway ?? ""}`,
      })),
    ],
    [networkOptions, networksLoading],
  );
  const gitProviderSelectOptions = useMemo(
    () =>
      gitProviders.length === 0
        ? [
            {
              value: "",
              label: providersLoading
                ? "Loading providers..."
                : "No enabled providers",
            },
          ]
        : gitProviders.map((provider) => ({
            value: provider.id,
            label: provider.name,
            description: provider.provider,
            keywords: `${provider.name} ${provider.provider} ${
              provider.namespace
            } ${provider.accountUsername} ${provider.organizationName} ${
              provider.providerUrl
            }`,
          })),
    [gitProviders, providersLoading],
  );
  const selectedGitBuildTypeOption = useMemo(
    () =>
      gitBuildTypeOptions.find((option) => option.value === form.buildType) ??
      gitBuildTypeOptions[0],
    [form.buildType],
  );

  const repositoryOptions = useMemo(
    () =>
      providerRepositories.map((repository) => ({
        value: repository.cloneUrl,
        label: repository.name,
        description: repository.fullName.includes("/")
          ? repository.fullName.slice(0, repository.fullName.lastIndexOf("/"))
          : repository.fullName,
        keywords: `${repository.fullName} ${repository.name} ${repository.defaultBranch} ${repository.htmlUrl}`,
      })),
    [providerRepositories],
  );

  const branchOptions = useMemo(
    () =>
      providerBranches.map((branch) => ({
        value: branch.name,
        label: branch.name,
        description: branch.isDefault
          ? "Default branch"
          : branch.commitSha
            ? `Commit ${branch.commitSha.slice(0, 7)}`
            : undefined,
        keywords: `${branch.name} ${branch.commitSha}`,
      })),
    [providerBranches],
  );

  useEffect(() => {
    let isActive = true;

    projectsApi
      .list()
      .then((response) => {
        if (!isActive) {
          return;
        }
        setProjectOptions(response.data ?? []);
      })
      .catch(() => {
        if (!isActive) {
          return;
        }
        setProjectOptions([]);
      })
      .finally(() => {
        if (!isActive) {
          return;
        }
        setProjectsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!showNetworkSelector || !form.serverId) {
      setNetworkOptions([]);
      setNetworksError("");
      setForm((current) =>
        current.networkId ? { ...current, networkId: "" } : current,
      );
      return;
    }

    let mounted = true;

    const loadNetworks = async () => {
      setNetworksLoading(true);
      setNetworksError("");
      try {
        const response = await networksApi.list(form.serverId);
        if (!mounted) return;

        const networks = response.data;
        setNetworkOptions(networks);
        setForm((current) => {
          if (!current.networkId) {
            return current;
          }

          const exists = networks.some(
            (network) => network.id === current.networkId,
          );
          return exists ? current : { ...current, networkId: "" };
        });
      } catch (err) {
        if (!mounted) return;
        setNetworkOptions([]);
        setNetworksError(
          err instanceof Error
            ? err.message
            : "Failed to load available networks",
        );
      } finally {
        if (mounted) setNetworksLoading(false);
      }
    };

    void loadNetworks();
    return () => {
      mounted = false;
    };
  }, [form.serverId, form.deployMode, showNetworkSelector]);

  useEffect(() => {
    if (choice !== "GIT_PROVIDER") return;
    let mounted = true;

    const loadProviders = async () => {
      setProvidersLoading(true);
      try {
        const response = await gitProvidersApi.list();
        if (!mounted) return;
        const enabledProviders = response.data.filter(
          (provider) => provider.enabled,
        );
        setGitProviders(enabledProviders);
        setForm((current) => ({
          ...current,
          gitProviderId: current.gitProviderId || enabledProviders[0]?.id || "",
        }));
      } catch (err) {
        if (!mounted) return;
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load configured git providers",
        );
      } finally {
        if (mounted) setProvidersLoading(false);
      }
    };

    void loadProviders();
    return () => {
      mounted = false;
    };
  }, [choice]);

  useEffect(() => {
    if (choice !== "GIT_PROVIDER" || !form.gitProviderId) {
      setProviderRepositories([]);
      setProviderBranches([]);
      setProviderDataError("");
      return;
    }

    let mounted = true;

    const loadRepositories = async () => {
      setRepositoriesLoading(true);
      setProviderDataError("");
      try {
        const response = await gitProvidersApi.listRepositories(
          form.gitProviderId,
        );
        if (!mounted) return;

        const repositories = response.data;
        setProviderRepositories(repositories);
        setForm((current) => {
          const existingRepository = repositories.find(
            (repository) => repository.cloneUrl === current.repoUrl,
          );
          const nextRepository = existingRepository ?? repositories[0] ?? null;

          return {
            ...current,
            repoUrl: nextRepository?.cloneUrl ?? "",
            repoBranch:
              nextRepository && (!current.repoBranch || !existingRepository)
                ? nextRepository.defaultBranch
                : current.repoBranch,
            repoVisibility: nextRepository?.visibility ?? "PUBLIC",
            accessToken:
              nextRepository?.visibility === "PRIVATE"
                ? current.accessToken
                : "",
          };
        });
      } catch (err) {
        if (!mounted) return;
        setProviderRepositories([]);
        setProviderBranches([]);
        setForm((current) => ({
          ...current,
          repoUrl: "",
          repoBranch: "",
          repoVisibility: "PUBLIC",
          accessToken: "",
        }));
        setProviderDataError(
          err instanceof Error
            ? err.message
            : "Failed to load repositories for the selected provider",
        );
      } finally {
        if (mounted) setRepositoriesLoading(false);
      }
    };

    void loadRepositories();
    return () => {
      mounted = false;
    };
  }, [choice, form.gitProviderId]);

  useEffect(() => {
    if (
      choice !== "GIT_PROVIDER" ||
      !form.gitProviderId ||
      !selectedProviderRepository
    ) {
      setProviderBranches([]);
      return;
    }

    let mounted = true;

    const loadBranches = async () => {
      setBranchesLoading(true);
      setProviderDataError("");
      try {
        const response = await gitProvidersApi.listBranches(
          form.gitProviderId,
          selectedProviderRepository.fullName,
          selectedProviderRepository.defaultBranch,
        );
        if (!mounted) return;

        const branches = response.data;
        const fallbackBranch =
          branches.find((branch) => branch.isDefault)?.name ||
          branches[0]?.name ||
          selectedProviderRepository.defaultBranch ||
          "";

        setProviderBranches(branches);
        setForm((current) => {
          if (current.repoUrl !== selectedProviderRepository.cloneUrl) {
            return current;
          }

          const branchNames = new Set(branches.map((branch) => branch.name));
          return {
            ...current,
            repoBranch:
              current.repoBranch && branchNames.has(current.repoBranch)
                ? current.repoBranch
                : fallbackBranch,
          };
        });
      } catch (err) {
        if (!mounted) return;
        setProviderBranches([]);
        setProviderDataError(
          err instanceof Error
            ? err.message
            : "Failed to load branches for the selected repository",
        );
        setForm((current) => ({
          ...current,
          repoBranch:
            selectedProviderRepository.defaultBranch || current.repoBranch,
        }));
      } finally {
        if (mounted) setBranchesLoading(false);
      }
    };

    void loadBranches();
    return () => {
      mounted = false;
    };
  }, [choice, form.gitProviderId, selectedProviderRepository]);

  const requiresRunOptions =
    choice === "MANUAL" &&
    (form.deployMode === "IMAGE" || form.deployMode === "DOCKERFILE");

  const formTitle = useMemo(() => {
    if (choice === "MANUAL") return "Manual Deploy";
    if (choice === "GIT_CLONE") return "Deploy from Git Clone Repo";
    if (choice === "GIT_PROVIDER") return "Deploy from Git Provider";
    return "Deploy Container";
  }, [choice]);

  const updateForm = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const selectChoice = (nextChoice: DeployChoice) => {
    setChoice(nextChoice);
    setError("");
    setProviderDataError("");
    setProviderRepositories([]);
    setProviderBranches([]);
    setForm((current) => ({
      ...current,
      deployMode: nextChoice === "MANUAL" ? "IMAGE" : current.deployMode,
      buildType: nextChoice === "MANUAL" ? current.buildType : "NIXPACKS",
      repoUrl: nextChoice === "GIT_PROVIDER" ? "" : current.repoUrl,
      repoBranch: nextChoice === "GIT_PROVIDER" ? "" : current.repoBranch,
      repoVisibility: "PUBLIC",
      accessToken: "",
      networkId: "",
      buildPath: "/",
      startCommand: "",
      portOverride: "",
      publishDirectory: "dist",
      composeEnvFiles: [],
      composeFilePath: "docker-compose.yml",
      dockerfilePath: "Dockerfile",
    }));
  };

  const handleGitBuildTypeChange = (value: GitBuildType) => {
    setForm((current) => ({
      ...current,
      buildType: value,
      startCommand: value === "COMPOSE" ? "" : current.startCommand,
      portOverride: value === "COMPOSE" ? "" : current.portOverride,
      publishDirectory:
        value === "STATIC" ? current.publishDirectory || "dist" : "dist",
      composeEnvFiles: value === "COMPOSE" ? current.composeEnvFiles : [],
      composeFilePath:
        value === "COMPOSE"
          ? current.composeFilePath || "docker-compose.yml"
          : "docker-compose.yml",
      dockerfilePath:
        value === "DOCKERFILE"
          ? current.dockerfilePath || "Dockerfile"
          : "Dockerfile",
    }));
  };

  const handleProviderRepositoryChange = (cloneUrl: string) => {
    const repository = providerRepositories.find(
      (item) => item.cloneUrl === cloneUrl,
    );

    setProviderDataError("");
    setProviderBranches([]);
    setForm((current) => ({
      ...current,
      repoUrl: cloneUrl,
      repoBranch: repository?.defaultBranch || current.repoBranch,
      repoVisibility: repository?.visibility ?? "PUBLIC",
      accessToken:
        repository?.visibility === "PRIVATE" ? current.accessToken : "",
    }));
  };

  const updateComposeEnvFile = (
    id: string,
    patch: Partial<Omit<ComposeEnvFileDraft, "id">>,
  ) => {
    setForm((current) => ({
      ...current,
      composeEnvFiles: current.composeEnvFiles.map((item) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    }));
  };

  const addComposeEnvFile = () => {
    setForm((current) => ({
      ...current,
      composeEnvFiles: [
        ...current.composeEnvFiles,
        createComposeEnvFileDraft(),
      ],
    }));
  };

  const removeComposeEnvFile = (id: string) => {
    setForm((current) => ({
      ...current,
      composeEnvFiles: current.composeEnvFiles.filter((item) => item.id !== id),
    }));
  };

  const triggerEnvFileUpload = (id: string) => {
    setUploadTargetEnvId(id);
    envFileInputRef.current?.click();
  };

  const handleComposeEnvFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    const targetId = uploadTargetEnvId;
    event.target.value = "";
    setUploadTargetEnvId(null);

    if (!file || !targetId) {
      return;
    }

    try {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () =>
          reject(new Error("Failed to read selected file"));
        reader.readAsText(file);
      });

      updateComposeEnvFile(targetId, {
        path: file.name,
        content,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to import env file",
      );
    }
  };

  const openAppInstaller = () => {
    router.push("/apps");
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    currentJobIdRef.current = null;
    cancelRequestedRef.current = false;
    let processLogLines = [
      `[deploy] Starting deployment for ${form.name || "new container"}`,
    ];

    try {
      if (!choice) {
        throw new Error("Choose a deploy source first");
      }

      processLogLines = [
        `[deploy] Starting deployment for ${form.name || "new container"}`,
        `[deploy] Source: ${choice}`,
        `[deploy] Server ID: ${form.serverId}`,
      ];
      let latestTerminalLogs = [...processLogLines];

      const updateProcessTerminal = (
        lines: string[],
        patch: Partial<ProcessLogsModalState> = {},
      ) => {
        latestTerminalLogs = lines;
        onProcessUpdate?.({
          terminalLogs: latestTerminalLogs,
          ...patch,
        });
      };

      openDeployTimelineModal({
        onProcessOpen,
        name: form.name,
        terminalLogs: processLogLines,
      });

      const payload: ContainerDeployBody = {
        name: form.name,
        serverId: form.serverId,
        environmentId: form.environmentId || undefined,
        networkId: form.networkId || undefined,
        sourceType: choice,
      };

      if (choice === "MANUAL") {
        updateDeployTimelineModal({
          onProcessUpdate,
          activeStep: 1,
          terminalLogs: [
            ...processLogLines,
            `[deploy] Preparing manual ${form.deployMode.toLowerCase()} deployment`,
          ],
          statusLabel: "Preparing",
        });

        payload.deployMode = form.deployMode;

        if (form.deployMode === "IMAGE") {
          payload.image = form.image;
          payload.ports = form.ports || undefined;
          payload.env = form.env || undefined;
          payload.restartPolicy = form.restartPolicy;
          payload.volumes = form.volumes || undefined;
        }

        if (form.deployMode === "COMPOSE") {
          payload.composeContent = form.composeContent;
        }

        if (form.deployMode === "DOCKERFILE") {
          payload.dockerfileContent = form.dockerfileContent;
          payload.imageTag = form.imageTag || undefined;
          payload.ports = form.ports || undefined;
          payload.env = form.env || undefined;
          payload.restartPolicy = form.restartPolicy;
          payload.volumes = form.volumes || undefined;
        }
      }

      if (choice === "GIT_CLONE" || choice === "GIT_PROVIDER") {
        updateDeployTimelineModal({
          onProcessUpdate,
          activeStep: 1,
          terminalLogs: [
            ...processLogLines,
            `[deploy] Preparing ${form.buildType.toLowerCase()} build from repository`,
            `[deploy] Repository: ${form.repoUrl || "selected provider repository"}`,
          ],
          statusLabel: "Preparing",
        });

        payload.buildType = form.buildType;
        payload.buildPath = form.buildPath || "/";
        payload.startCommand = form.startCommand || undefined;
        payload.portOverride = form.portOverride || undefined;
        payload.publishDirectory =
          form.buildType === "STATIC"
            ? form.publishDirectory || undefined
            : undefined;
        payload.deployMode =
          form.buildType === "DOCKERFILE" || form.buildType === "COMPOSE"
            ? form.buildType
            : undefined;

        const composeEnvFiles = form.composeEnvFiles
          .map((item) => ({
            path: item.path.trim(),
            content: item.content,
          }))
          .filter((item) => item.path || item.content);

        if (
          form.buildType === "COMPOSE" &&
          composeEnvFiles.some((item) => !item.path || !item.content.trim())
        ) {
          throw new Error(
            "Each Compose env override must have both file path and content",
          );
        }

        if (form.buildType === "STATIC" && !form.publishDirectory.trim()) {
          throw new Error(
            "Publish directory is required for static build type",
          );
        }

        payload.repoUrl = form.repoUrl;
        payload.repoBranch = form.repoBranch || undefined;
        payload.repoVisibility = form.repoVisibility;
        payload.accessToken =
          form.repoVisibility === "PRIVATE" ? form.accessToken : undefined;
        payload.composeFilePath =
          form.buildType === "COMPOSE"
            ? form.composeFilePath || undefined
            : undefined;
        payload.composeEnvFiles =
          form.buildType === "COMPOSE" && composeEnvFiles.length > 0
            ? composeEnvFiles
            : undefined;
        payload.dockerfilePath =
          form.buildType === "DOCKERFILE"
            ? form.dockerfilePath || undefined
            : undefined;
        payload.dockerContextPath =
          form.buildType === "DOCKERFILE"
            ? form.buildPath || undefined
            : undefined;

        if (choice === "GIT_PROVIDER") {
          if (!form.repoUrl) {
            throw new Error("Select a repository from the chosen Git provider");
          }
          payload.gitProviderId = form.gitProviderId;
        }
      }

      latestTerminalLogs = [
        ...processLogLines,
        "[deploy] Payload validated",
        "[deploy] Sending deployment request to server",
      ];
      updateDeployTimelineModal({
        onProcessUpdate,
        activeStep: 2,
        terminalLogs: latestTerminalLogs,
        statusLabel: "Running",
      });

      const jobResponse = await containersApi.createDeployJob(payload);
      const job = jobResponse.data;
      currentJobIdRef.current = job.id;
      let finalStatus = job.status;
      let finalError = job.error;

      updateProcessTerminal(
        [
          ...latestTerminalLogs,
          `[job] Deployment job created: ${job.id}`,
          "[job] Streaming backend deployment logs",
        ],
        createDeployTimelineUpdate({
          activeStep: 2,
          statusLabel: "Streaming",
        }),
      );

      onProcessUpdate?.({
        cancelAction: {
          label: "Cancel",
          loadingLabel: "Cancelling",
          onClick: () => {
            const jobId = currentJobIdRef.current;
            if (!jobId || cancelRequestedRef.current) return;

            cancelRequestedRef.current = true;
            onProcessUpdate?.({
              statusLabel: "Cancelling",
              cancelAction: {
                label: "Cancel",
                loadingLabel: "Cancelling",
                isLoading: true,
                disabled: true,
                onClick: () => undefined,
              },
            });

            void containersApi.cancelJob(jobId).catch(() => undefined);
          },
        },
      });

      await containersApi.streamJob(job.id, {
        onLog: (entry) => {
          updateProcessTerminal(
            [...latestTerminalLogs, entry.message],
            createDeployTimelineUpdate({
              activeStep: 2,
              statusLabel: "Streaming",
            }),
          );
        },
        onStatus: (nextJob) => {
          finalStatus = nextJob.status;
          finalError = nextJob.error;
        },
      });

      if (cancelRequestedRef.current && finalStatus !== "cancelled") {
        const cancelledJob = currentJobIdRef.current
          ? await containersApi.getJob(currentJobIdRef.current)
          : null;
        finalStatus = cancelledJob?.data.status ?? "cancelled";
        finalError =
          cancelledJob?.data.error ??
          cancelledJob?.data.cancelReason ??
          "Deployment cancelled";
      }

      if (finalStatus === "error") {
        throw new Error(finalError || "Deployment job failed");
      }

      if (finalStatus === "cancelled") {
        throw new Error(finalError || "Deployment cancelled");
      }

      updateDeployTimelineModal({
        onProcessUpdate,
        activeStep: 3,
        terminalLogs: [
          ...latestTerminalLogs,
          "[deploy] Deployment command completed",
          "[deploy] Refreshing container inventory",
        ].filter(Boolean),
        statusLabel: "Syncing",
      });

      await Promise.resolve(onDeployed());

      completeDeployTimelineModal({
        onProcessUpdate,
        terminalLogs: [
          ...latestTerminalLogs,
          "[deploy] Deployment command completed",
          "[deploy] Container inventory refreshed",
          "[deploy] Done",
        ].filter(Boolean),
      });
      onProcessUpdate?.({ cancelAction: undefined });

      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Deploy failed";
      setError(message);
      onToast?.({
        tone: "error",
        title: "Container Deploy",
        message,
        showProgress: true,
      });
      failDeployTimelineModal({
        onProcessUpdate,
        name: form.name,
        message,
      });
      onProcessUpdate?.({ cancelAction: undefined });
    } finally {
      currentJobIdRef.current = null;
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-shell" style={{ maxWidth: 640 }}>
        <button
          type="button"
          onClick={onClose}
          className="modal-close"
          aria-label="Close deploy container modal"
        >
          <X size={22} />
        </button>
      <div
        className="modal animate-slide-in"
        style={{
          width: "100%",
          maxWidth: 640,
          maxHeight: "90vh",
          padding: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 20,
            gap: 12,
            paddingRight: 36,
          }}
        >
          <div>
            <h3
              style={{
                color: "var(--text-primary)",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  // justifyContent: "space-between",
                  gap: 10,
                }}
              >
                {choice !== null ? (
                  <ArrowLeft
                    size={24}
                    cursor="pointer"
                    onClick={() => {
                      setChoice(null);
                      setError("");
                      setProviderDataError("");
                      setProviderRepositories([]);
                      setProviderBranches([]);
                    }}
                  />
                ) : null}
                {formTitle}
              </div>{" "}
            </h3>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                marginTop: 4,
              }}
            >
              {choice
                ? "Select server and configure deployment options, then submit to deploy the container."
                : "Select a source to deploy from. You can choose from pre-built app templates, connect your Git provider, or manually enter deployment details."}
            </p>
          </div>
        </div>
        {error ? (
          <div
            style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 14,
              fontSize: 13,
              color: "#ef4444",
            }}
          >
            {error}
          </div>
        ) : null}
        {choice === null ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            <button type="button" onClick={openAppInstaller} style={cardStyles}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 14 }}>App Installer</strong>
                <ExternalLink size={14} />
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Use pre-built app templates for popular runtimes, databases, and
                tools, with one-click deploy and optimized defaults.
              </p>
            </button>

            <button
              type="button"
              onClick={() => selectChoice("MANUAL")}
              style={cardStyles}
            >
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>Manual</strong>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Deploy via old Docker images, paste Docker Compose, or build
                from manual Dockerfile scripts.
              </p>
            </button>

            <button
              type="button"
              onClick={() => selectChoice("GIT_CLONE")}
              style={cardStyles}
            >
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>Git Clone Repo</strong>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Clone public/private repos. For private repos, enter an access
                token during deployment.
              </p>
            </button>

            <button
              type="button"
              onClick={() => selectChoice("GIT_PROVIDER")}
              style={cardStyles}
            >
              <div style={{ marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>Git Providers</strong>
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                Select a configured Git provider, then choose a repository from
                that provider directly.
              </p>
            </button>
          </div>
        ) : (
          <form
            onSubmit={submit}
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
          >
            <hr style={{ borderColor: "rgba(59,130,246,0.24)" }} />
            {/* <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setChoice(null);
                  setError("");
                  setProviderDataError("");
                  setProviderRepositories([]);
                  setProviderBranches([]);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: "var(--bg-secondary)",
                }}
              >
                <ArrowLeft size={14} /> Back
              </button>
            </div> */}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <div>
                {fieldLabel("Container / Project Name *")}
                <input
                  className="input"
                  value={form.name}
                  onChange={(event) => updateForm("name", event.target.value)}
                  placeholder="my-app"
                  required
                  style={{ width: "100%" }}
                />
              </div>
              <div>
                {fieldLabel("Server *")}
                <SearchableSelect
                  value={form.serverId}
                  options={serverSelectOptions}
                  onChange={(value) => {
                    if (lockEnvironmentSelection) return;
                    updateForm("serverId", value);
                    updateForm("environmentId", "");
                  }}
                  placeholder="Select server"
                  searchPlaceholder="Search server..."
                  emptyText="No server found"
                  disabled={serverList.length === 0 || lockEnvironmentSelection}
                />
              </div>
            </div>

            <div>
              {fieldLabel("Project Environment *")}
              <SearchableSelect
                value={form.environmentId}
                options={environmentSelectOptions}
                onChange={(value) => updateForm("environmentId", value)}
                placeholder={
                  projectsLoading
                    ? "Loading environments..."
                    : availableEnvironments.length > 0
                      ? "No environment selected"
                      : "No environment mapped to this server"
                }
                searchPlaceholder="Search environment..."
                emptyText="No environment found"
                disabled={
                  !form.serverId || projectsLoading || lockEnvironmentSelection
                }
              />
              <p
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {lockEnvironmentSelection
                  ? "Locked to the current environment. New deployments from this page will be attached here."
                  : availableEnvironments.length > 0
                    ? "Optional. When selected, the deployed container will be attached to that environment."
                    : "Create a project environment on the Projects page first if you want deployment ownership beyond server scope."}
              </p>
            </div>

            {showNetworkSelector ? (
              <div>
                {fieldLabel("Docker Network")}
                <SearchableSelect
                  value={form.networkId}
                  options={networkSelectOptions}
                  onChange={(value) => updateForm("networkId", value)}
                  placeholder={
                    networksLoading
                      ? "Loading networks..."
                      : "Bridge default / no explicit network"
                  }
                  searchPlaceholder="Search network..."
                  emptyText="No network found"
                  disabled={networksLoading}
                />
                <p
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: networksError ? "#fca5a5" : "var(--text-muted)",
                    lineHeight: 1.5,
                  }}
                >
                  {networksError ||
                    "Select a network that is already stored in the DB for this server so that the cloned app can communicate with other services on the same network.."}
                </p>
              </div>
            ) : null}

            {choice === "MANUAL" ? (
              <div>
                {fieldLabel("Manual Mode")}
                <select
                  className="input"
                  value={form.deployMode}
                  onChange={(event) =>
                    updateForm(
                      "deployMode",
                      event.target.value as ContainerDeployMode,
                    )
                  }
                  style={{ width: "100%", cursor: "pointer" }}
                >
                  <option value="IMAGE">Docker Image</option>
                  <option value="COMPOSE">Docker Compose</option>
                  <option value="DOCKERFILE">Dockerfile</option>
                </select>
              </div>
            ) : null}

            {choice === "GIT_CLONE" || choice === "GIT_PROVIDER" ? (
              <>
                <input
                  ref={envFileInputRef}
                  type="file"
                  hidden
                  onChange={handleComposeEnvFileUpload}
                />

                {choice === "GIT_PROVIDER" ? (
                  <div>
                    {fieldLabel("Git Provider *")}
                    <SearchableSelect
                      value={form.gitProviderId}
                      options={gitProviderSelectOptions}
                      onChange={(value) => updateForm("gitProviderId", value)}
                      placeholder={
                        providersLoading
                          ? "Loading providers..."
                          : gitProviders.length === 0
                            ? "No enabled providers"
                            : "Select Git provider"
                      }
                      searchPlaceholder="Search provider..."
                      emptyText="No provider found"
                      disabled={providersLoading || gitProviders.length === 0}
                    />
                    <p
                      style={{
                        marginTop: 6,
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      Repo list is loaded from the selected provider based on
                      the configured namespace, organization, or account
                      username.
                    </p>
                    {providerDataError ? (
                      <div
                        style={{
                          marginTop: 8,
                          background: "rgba(239,68,68,0.1)",
                          border: "1px solid rgba(239,68,68,0.25)",
                          borderRadius: 8,
                          padding: "10px 12px",
                          fontSize: 12,
                          lineHeight: 1.5,
                          color: "#fca5a5",
                        }}
                      >
                        {providerDataError}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {choice === "GIT_CLONE" ? (
                  <div>
                    {fieldLabel("Repository URL *")}
                    <input
                      className="input"
                      value={form.repoUrl}
                      onChange={(event) =>
                        updateForm("repoUrl", event.target.value)
                      }
                      placeholder="https://github.com/owner/repo.git"
                      required
                      style={{ width: "100%" }}
                    />
                  </div>
                ) : (
                  <div>
                    {fieldLabel("Repository *")}
                    <SearchableSelect
                      value={form.repoUrl}
                      options={repositoryOptions}
                      onChange={handleProviderRepositoryChange}
                      placeholder={
                        repositoriesLoading
                          ? "Loading repositories..."
                          : providerRepositories.length === 0
                            ? "No repositories available"
                            : "Select repository"
                      }
                      searchPlaceholder="Search repository..."
                      emptyText="No repository matched"
                      disabled={
                        repositoriesLoading || providerRepositories.length === 0
                      }
                      style={{ width: "100%" }}
                    />
                    {selectedProviderRepository ? (
                      <p
                        style={{
                          marginTop: 6,
                          fontSize: 11,
                          color: "var(--text-muted)",
                          lineHeight: 1.5,
                        }}
                      >
                        {selectedProviderRepository.htmlUrl}
                      </p>
                    ) : null}
                  </div>
                )}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <div>
                    {fieldLabel("Branch*")}
                    {choice === "GIT_PROVIDER" ? (
                      <SearchableSelect
                        value={form.repoBranch}
                        options={branchOptions}
                        onChange={(value) => updateForm("repoBranch", value)}
                        placeholder={
                          branchesLoading
                            ? "Loading branches..."
                            : providerBranches.length === 0
                              ? "No branches available"
                              : "Select Branch"
                        }
                        searchPlaceholder="Search branch..."
                        emptyText="No branch matched"
                        disabled={
                          branchesLoading || providerBranches.length === 0
                        }
                        style={{ width: "100%" }}
                      />
                    ) : (
                      <input
                        className="input"
                        value={form.repoBranch}
                        onChange={(event) =>
                          updateForm("repoBranch", event.target.value)
                        }
                        placeholder="main"
                        style={{ width: "100%" }}
                      />
                    )}
                  </div>
                  <div>
                    {fieldLabel("Build Path*")}
                    <input
                      className="input"
                      value={form.buildPath}
                      onChange={(event) =>
                        updateForm("buildPath", event.target.value)
                      }
                      placeholder="/"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 14,
                    borderRadius: 12,
                    border: "1px solid rgba(59,130,246,0.16)",
                    background: "rgba(59,130,246,0.08)",
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
                      Build Type*
                    </div>
                    <p
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        color: "var(--text-muted)",
                        lineHeight: 1.5,
                      }}
                    >
                      The default is `Nixpacks`, so that repos without a
                      Dockerfile or docker-compose can still be detected and
                      built automatically.
                    </p>
                  </div>

                  <select
                    className="input"
                    value={form.buildType}
                    onChange={(event) =>
                      handleGitBuildTypeChange(
                        event.target.value as GitBuildType,
                      )
                    }
                    style={{ width: "100%", cursor: "pointer" }}
                  >
                    {gitBuildTypeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p
                    style={{
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: "var(--text-muted)",
                    }}
                  >
                    {selectedGitBuildTypeOption.description}
                  </p>
                </div>

                <div>
                  {fieldLabel("Repository Visibility*")}
                  {choice === "GIT_CLONE" ? (
                    <select
                      className="input"
                      value={form.repoVisibility}
                      onChange={(event) =>
                        updateForm(
                          "repoVisibility",
                          event.target.value as RepositoryVisibility,
                        )
                      }
                      style={{ width: "100%", cursor: "pointer" }}
                    >
                      <option value="PUBLIC">Public</option>
                      <option value="PRIVATE">Private</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      value={form.repoVisibility}
                      readOnly
                      style={{ width: "100%" }}
                    />
                  )}
                </div>

                {form.repoVisibility === "PRIVATE" ? (
                  <div>
                    {fieldLabel("Access Token*")}
                    <input
                      className="input"
                      type="password"
                      value={form.accessToken}
                      onChange={(event) =>
                        updateForm("accessToken", event.target.value)
                      }
                      placeholder="ghp_... / glpat-... / token"
                      required
                      style={{ width: "100%" }}
                    />
                  </div>
                ) : null}

                {showStaticSettings ? (
                  <div>
                    {fieldLabel("Publish Directory*")}
                    <input
                      className="input"
                      value={form.publishDirectory}
                      onChange={(event) =>
                        updateForm("publishDirectory", event.target.value)
                      }
                      placeholder="dist"
                      style={{ width: "100%" }}
                    />
                  </div>
                ) : null}

                {showGitDockerfileSettings ? (
                  <div>
                    {fieldLabel("Dockerfile Path*")}
                    <input
                      className="input"
                      value={form.dockerfilePath}
                      onChange={(event) =>
                        updateForm("dockerfilePath", event.target.value)
                      }
                      placeholder="Dockerfile"
                      style={{ width: "100%" }}
                    />
                  </div>
                ) : null}

                {showGitComposeSettings ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                      padding: 14,
                      borderRadius: 12,
                      border: "1px solid rgba(59,130,246,0.18)",
                      background: "rgba(59,130,246,0.08)",
                    }}
                  >
                    <div>
                      {fieldLabel("Compose File Path*")}
                      <input
                        className="input"
                        value={form.composeFilePath}
                        onChange={(event) =>
                          updateForm("composeFilePath", event.target.value)
                        }
                        placeholder="docker-compose.yml"
                        style={{ width: "100%" }}
                      />
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                        alignItems: "center",
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
                          Compose `.env` Override
                        </div>
                        <p
                          style={{
                            marginTop: 4,
                            fontSize: 11,
                            lineHeight: 1.55,
                            color: "var(--text-muted)",
                          }}
                        >
                          Optional. This file is only created in the deployment
                          folder on the server, does not modify the source repo,
                          and is not saved to the database.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        onClick={addComposeEnvFile}
                      >
                        Add Env File
                      </button>
                    </div>

                    {form.composeEnvFiles.length === 0 ? (
                      <div
                        style={{
                          padding: "10px 12px",
                          borderRadius: 10,
                          background: "rgba(255,255,255,0.03)",
                          fontSize: 12,
                          color: "var(--text-secondary)",
                        }}
                      >
                        Only add if the Compose repo requires an `env_file` such
                        as `.env` or `src/.env` that is not included in the
                        repo.
                      </div>
                    ) : null}

                    {form.composeEnvFiles.map((item, index) => (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 10,
                          padding: 12,
                          borderRadius: 10,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(59,130,246,0.08)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 10,
                            flexWrap: "wrap",
                          }}
                        >
                          <strong style={{ fontSize: 12 }}>
                            Env File {index + 1}
                          </strong>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                            }}
                          >
                            <button
                              type="button"
                              className="btn"
                              onClick={() => triggerEnvFileUpload(item.id)}
                            >
                              Upload File
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => removeComposeEnvFile(item.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        <div>
                          {fieldLabel("File Path in Repo")}
                          <input
                            className="input"
                            value={item.path}
                            onChange={(event) =>
                              updateComposeEnvFile(item.id, {
                                path: event.target.value,
                              })
                            }
                            placeholder=".env or src/.env"
                            style={{ width: "100%" }}
                          />
                        </div>

                        <div>
                          {fieldLabel("File Content")}
                          <textarea
                            className="input"
                            value={item.content}
                            onChange={(event) =>
                              updateComposeEnvFile(item.id, {
                                content: event.target.value,
                              })
                            }
                            rows={6}
                            style={{
                              width: "100%",
                              fontFamily: "monospace",
                              resize: "vertical",
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {showRuntimeOverrideSettings ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 12,
                    }}
                  >
                    <div>
                      {fieldLabel("Port Override*")}
                      <input
                        className="input"
                        value={form.portOverride}
                        onChange={(event) =>
                          updateForm("portOverride", event.target.value)
                        }
                        placeholder="3000 or 8080:3000"
                        style={{ width: "100%" }}
                      />
                    </div>
                    <div>
                      {fieldLabel("Start Command")}
                      <input
                        className="input"
                        value={form.startCommand}
                        onChange={(event) =>
                          updateForm("startCommand", event.target.value)
                        }
                        placeholder="npm run start"
                        style={{ width: "100%" }}
                      />
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {choice === "MANUAL" && form.deployMode === "IMAGE" ? (
              <div>
                {fieldLabel("Image *")}
                <input
                  className="input"
                  value={form.image}
                  onChange={(event) => updateForm("image", event.target.value)}
                  placeholder="nginx:alpine"
                  required
                  style={{ width: "100%" }}
                />
              </div>
            ) : null}

            {choice === "MANUAL" && form.deployMode === "COMPOSE" ? (
              <div>
                {fieldLabel("Compose Content *")}
                <textarea
                  className="input"
                  value={form.composeContent}
                  onChange={(event) =>
                    updateForm("composeContent", event.target.value)
                  }
                  rows={12}
                  required
                  style={{
                    width: "100%",
                    fontFamily: "monospace",
                    resize: "vertical",
                  }}
                />
              </div>
            ) : null}

            {choice === "MANUAL" && form.deployMode === "DOCKERFILE" ? (
              <>
                <div>
                  {fieldLabel("Dockerfile Content *")}
                  <textarea
                    className="input"
                    value={form.dockerfileContent}
                    onChange={(event) =>
                      updateForm("dockerfileContent", event.target.value)
                    }
                    rows={10}
                    required
                    style={{
                      width: "100%",
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                </div>
                <div>
                  {fieldLabel("Image Tag")}
                  <input
                    className="input"
                    value={form.imageTag}
                    onChange={(event) =>
                      updateForm("imageTag", event.target.value)
                    }
                    placeholder="doktainer/my-app:latest"
                    style={{ width: "100%" }}
                  />
                </div>
              </>
            ) : null}

            {requiresRunOptions ? (
              <>
                <div>
                  {fieldLabel("Port Mapping")}
                  <input
                    className="input"
                    value={form.ports}
                    onChange={(event) =>
                      updateForm("ports", event.target.value)
                    }
                    placeholder="80:80, 443:443"
                    style={{ width: "100%" }}
                  />
                </div>

                <div>
                  {fieldLabel("Environment Variables")}
                  <textarea
                    className="input"
                    value={form.env}
                    onChange={(event) => updateForm("env", event.target.value)}
                    rows={4}
                    placeholder={"NODE_ENV=production\nPORT=3000"}
                    style={{
                      width: "100%",
                      fontFamily: "monospace",
                      resize: "vertical",
                    }}
                  />
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <div>
                    {fieldLabel("Restart Policy")}
                    <select
                      className="input"
                      value={form.restartPolicy}
                      onChange={(event) =>
                        updateForm("restartPolicy", event.target.value)
                      }
                      style={{ width: "100%", cursor: "pointer" }}
                    >
                      <option value="unless-stopped">Unless Stopped</option>
                      <option value="always">Always</option>
                      <option value="on-failure">On Failure</option>
                      <option value="no">No</option>
                    </select>
                  </div>
                  <div>
                    {fieldLabel("Volumes")}
                    <input
                      className="input"
                      value={form.volumes}
                      onChange={(event) =>
                        updateForm("volumes", event.target.value)
                      }
                      placeholder="/data:/data"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>
              </>
            ) : null}

            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={onClose}
                className="btn"
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
                style={{
                  flex: 2,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                }}
              >
                {loading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : null}
                <RocketIcon size={14} />
                Deploy
              </button>
            </div>
          </form>
        )}
        </div>
      </div>
    </div>
  );
}
