ALTER TABLE "backups"
ADD COLUMN "storageBucket" TEXT,
ADD COLUMN "storageKey" TEXT,
ADD COLUMN "storageEtag" TEXT,
ADD COLUMN "storageDestinationId" TEXT;

