/*
  Warnings:

  - You are about to drop the column `objData` on the `Template` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail" TEXT,
    "modelFile" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "slug" TEXT NOT NULL,
    "editorState" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "authorId" TEXT NOT NULL,
    CONSTRAINT "Template_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Template" ("authorId", "createdAt", "description", "id", "isDefault", "isPublic", "modelFile", "name", "slug", "thumbnail", "updatedAt") SELECT "authorId", "createdAt", "description", "id", "isDefault", "isPublic", "modelFile", "name", "slug", "thumbnail", "updatedAt" FROM "Template";
DROP TABLE "Template";
ALTER TABLE "new_Template" RENAME TO "Template";
CREATE UNIQUE INDEX "Template_slug_key" ON "Template"("slug");
CREATE INDEX "Template_authorId_idx" ON "Template"("authorId");
CREATE INDEX "Template_isPublic_idx" ON "Template"("isPublic");
CREATE INDEX "Template_isDefault_idx" ON "Template"("isDefault");
CREATE INDEX "Template_slug_idx" ON "Template"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
