ALTER TABLE "servers"
  ALTER COLUMN "runtimeCollectorEnabled" SET DEFAULT true,
  ALTER COLUMN "runtimeCollectorIntervalSec" SET DEFAULT 300;
