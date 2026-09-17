import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { LIMITS, badRequest, checkString, isSafeDocument, isSafeThumbnail, readJson } from "@/lib/http"

export async function GET() {
  const session = await getServerSession(authOptions)
  const userId = (session?.user as any)?.id
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // The signed-in user's own custom presets (without heavy blobs)
    const templates = await prisma.template.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        modelFile: true,
        isPublic: true,
        isDefault: true,
        slug: true,
        author: { select: { id: true, name: true, image: true } },
      },
    })
    return NextResponse.json(templates)
  } catch (error) {
    console.error("Error fetching templates:", error)
    return NextResponse.json({ error: "Failed to fetch templates" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if ((session.user as any)?.accountType === "Customer") {
    return NextResponse.json({ error: "Customers cannot create or edit designs" }, { status: 403 })
  }

  const parsed = await readJson(request)
  if (parsed.error) return parsed.error
  const { name, description, modelFile, objData, editorState, thumbnail, documentData, documentName } = parsed.body

  if (!name || typeof name !== "string" || !name.trim()) {
    return badRequest("Template name is required")
  }
  const serializedEditorState =
    editorState && typeof editorState === "object" ? JSON.stringify(editorState) : editorState
  const invalid =
    checkString(name, "Name", LIMITS.name) ||
    checkString(description, "Description", LIMITS.description) ||
    checkString(modelFile, "Model file name", LIMITS.fileName) ||
    checkString(objData, "Model data", LIMITS.objData) ||
    checkString(serializedEditorState, "Design settings", LIMITS.editorState) ||
    checkString(documentData, "Attached document", LIMITS.documentData) ||
    checkString(documentName, "Document name", LIMITS.fileName) ||
    (!isSafeThumbnail(thumbnail) ? "Thumbnail must be a PNG, JPEG or WebP image" : null) ||
    (!isSafeDocument(documentData) ? "Attached document must be a PDF or Word file" : null)
  if (invalid) return badRequest(invalid)

  try {
    // Generate unique slug
    const cleanSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "design"
    const uniqueSlug = `${cleanSlug}-${Math.random().toString(36).substring(2, 6)}`

    const authorId = (session.user as any).id
    const userExists = await prisma.user.findUnique({ where: { id: authorId }, select: { id: true } })
    if (!userExists) {
      return NextResponse.json({ error: "Your session has expired. Please log out and log in again." }, { status: 401 })
    }

    const template = await prisma.template.create({
      data: {
        name: name.trim(),
        description: description || "",
        modelFile: modelFile || "",
        objData: objData || null,
        // Designs are never made public from the app; visibility goes through approval and sharing
        isPublic: false,
        isDefault: false,
        editorState: serializedEditorState || null,
        authorId,
        slug: uniqueSlug,
        thumbnail: thumbnail || null,
        documentData: documentData || null,
        documentName: documentName || null,
      },
      select: { id: true, slug: true, name: true },
    })

    return NextResponse.json(template, { status: 201 })
  } catch (error: any) {
    console.error("Error creating template:", error)
    return NextResponse.json({ error: "Failed to create template" }, { status: 500 })
  }
}
