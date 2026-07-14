import { Container, Server } from "@/lib/api";
import type { DatabaseKind } from "./database-constants";

export type DatabaseContainer = Container & {
  databaseType: DatabaseKind;
  databaseLabel: string;
  databaseColor: string;
  exposedPort: string;
};

export interface AddDatabaseModalProps {
  serverList: Server[];
  initialServerId?: string;
  initialEnvironmentId?: string;
  lockServerSelection?: boolean;
  onClose: () => void;
  onAdded: () => void;
}
