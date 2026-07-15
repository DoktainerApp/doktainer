ALTER TABLE "user_storage_destinations"
ADD COLUMN "retentionDays" INTEGER,
ADD COLUMN "maxBackupCount" INTEGER,
ADD COLUMN "objectPrefix" TEXT;

