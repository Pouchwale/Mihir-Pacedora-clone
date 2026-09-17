-- The Director role was removed: the Head of Designer reviews designs and shares them with customers.
UPDATE "User" SET "accountType" = 'Head of Designer' WHERE "accountType" = 'Director';

-- Designs waiting for a (now removed) second review stage are simply waiting for the Head of Designer.
UPDATE "ApprovalRequest" SET "status" = 'PENDING' WHERE "status" = 'PENDING_HEAD';

-- The "who may share with customers" setting no longer exists.
DELETE FROM "AppSetting" WHERE "key" = 'customerSharingRole';
