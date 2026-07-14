export const DB_APPS = ["postgres", "mysql", "mongodb", "redis"] as const;
export type DbType = (typeof DB_APPS)[number];
export type DatabaseKind = DbType | "mariadb";

export const DB_META: Record<
  DatabaseKind,
  { label: string; color: string; port: string; passEnv: string }
> = {
  postgres: {
    label: "PostgreSQL",
    color: "#3b82f6",
    port: "5432:5432",
    passEnv: "POSTGRES_PASSWORD",
  },
  mysql: {
    label: "MySQL",
    color: "#f59e0b",
    port: "3306:3306",
    passEnv: "MYSQL_ROOT_PASSWORD",
  },
  mongodb: {
    label: "MongoDB",
    color: "#10b981",
    port: "27017:27017",
    passEnv: "MONGO_INITDB_ROOT_PASSWORD",
  },
  mariadb: {
    label: "MariaDB",
    color: "#fb7185",
    port: "3306:3306",
    passEnv: "MARIADB_ROOT_PASSWORD",
  },
  redis: { label: "Redis", color: "#ef4444", port: "6379:6379", passEnv: "" },
};

export const typeColors: Record<string, string> = {
  PostgreSQL: "#3b82f6",
  MySQL: "#f59e0b",
  MongoDB: "#10b981",
  Redis: "#ef4444",
  postgres: "#3b82f6",
  mysql: "#f59e0b",
  mongodb: "#10b981",
  mariadb: "#fb7185",
  redis: "#ef4444",
};
