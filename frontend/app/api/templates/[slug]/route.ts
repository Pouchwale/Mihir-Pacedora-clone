import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { templateAccessWhere } from "@/lib/templateAccess"
import { LIMITS, badRequest, checkString, isSafeDocument, isSafeThumbnail, readJson } from "@/lib/http"

// GET: Template details the user may open (model, document and thumbnail have their own routes)
export async function GET(
  _request: Request,
  { params }: { params: { slug: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const template = await prisma.template.findFirst({
      where: await templateAccessWhere(session, params.slug),
      select: {
        id: true,
        name: true,
        description: true,
        modelFile: true,
        isPublic: true,
        isDefault: true,
        slug: true,
        editorState: true,
        documentName: true,
        author: { select: { id: true, name: true, image: true } },
      },
    })

    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 })
    }

    return NextResponse.json(template)
  } catch (error) {
    console.error("Error fetching template:", error)
    return NextResponse.json({ error: "Failed to fetch template" }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { slug: string } }
) {
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

  const serializedEditorState =
    editorState && typeof editorState === "object" ? JSON.stringify(editorState) : editorState
  const invalid =
    (name !== undefined && (typeof name !== "string" || !name.trim()) ? "Template name is required" : null) ||
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
    // Only the owner can update a design
    const existingTemplate = await prisma.template.findFirst({
      where: { slug: params.slug, authorId: (session.user as any).id },
      select: { id: true, slug: true },
    })

    if (!existingTemplate) {
      return NextResponse.json({ error: "Template not found or unauthorized" }, { status: 404 })
    }

    // Only fields that were sent are changed (isPublic can't be changed from the app)
    const template = await prisma.template.update({
      where: { id: existingTemplate.id },
      data: {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(description != null ? { description } : {}),
        ...(modelFile != null ? { modelFile } : {}),
        ...(objData != null ? { objData } : {}),
        ...(serializedEditorState != null ? { editorState: serializedEditorState } : {}),
        ...(thumbnail != null ? { thumbnail } : {}),
        ...(documentData !== undefined ? { documentData } : {}),
        ...(documentName !== undefined ? { documentName } : {}),
        updatedAt: new Date(),
      },
      select: { id: true, slug: true, name: true },
    })

    // Changing an approved design's content invalidates the approval: customers must only ever
    // see content the Head of Designer reviewed
    let reviewReset = false
    const contentChanged = objData != null || serializedEditorState != null || documentData !== undefined || modelFile != null
    if (contentChanged) {
      const latest = await prisma.approvalRequest.findFirst({
        where: { designSlug: existingTemplate.slug },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true },
      })
      if (latest?.status === "APPROVED") {
        await prisma.approvalRequest.update({
          where: { id: latest.id },
          data: { status: "PENDING", remarks: null, headStatus: null, headRemarks: null, headReviewer: null, customerStatus: null, customerRemarks: null },
        })
        reviewReset = true
      }
    }

    return NextResponse.json({ ...template, reviewReset })
  } catch (error) {
    console.error("Error updating template:", error)
    return NextResponse.json({ error: "Failed to update template" }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { slug: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    // Only the owner can delete a design
    const existingTemplate = await prisma.template.findFirst({
      where: { slug: params.slug, authorId: (session.user as any).id },
      select: { id: true, slug: true },
    })

    if (!existingTemplate) {
      return NextResponse.json({ error: "Template not found or unauthorized" }, { status: 404 })
    }

    // Remove the design's approval requests too, so no reviewer is left with a broken link
    await prisma.$transaction([
      prisma.approvalRequest.deleteMany({ where: { designSlug: existingTemplate.slug } }),
      prisma.template.delete({ where: { id: existingTemplate.id } }),
    ])

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Error deleting template:", error)
    return NextResponse.json({ error: "Failed to delete template" }, { status: 500 })
  }
}
