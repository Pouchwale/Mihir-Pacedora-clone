import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";
import { readJson } from "@/lib/http";

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as any)?.accountType || "Customer";
  const isOriginalAdmin = (session.user as any)?.originalAdminEmail;
  const isAuthorized = role === "Administrator" || isOriginalAdmin;

  if (!isAuthorized) {
    return NextResponse.json({ error: "Forbidden: Only administrators can impersonate accounts" }, { status: 403 });
  }

  const parsed = await readJson(request, 4096);
  if (parsed.error) return parsed.error;
  const email = typeof parsed.body.email === "string" ? parsed.body.email.trim().toLowerCase() : "";
  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  try {
    // Only active, non-administrator accounts can be accessed
    const target = await prisma.user.findUnique({ where: { email }, select: { accountType: true, isActive: true } });
    if (!target || !target.isActive || target.accountType === "Administrator") {
      return NextResponse.json({ error: "This account cannot be accessed" }, { status: 400 });
    }

    // Generate secure 32-character random token
    const token = crypto.randomBytes(16).toString("hex");
    
    // Set 1-minute expiration for single-use token
    const expires = new Date(Date.now() + 60 * 1000);

    const adminEmail = (session.user as any)?.originalAdminEmail || session.user?.email;
    if (!adminEmail) {
      return NextResponse.json({ error: "Admin email not found in session" }, { status: 400 });
    }

    // Store in VerificationToken table with structure impersonate:adminEmail:targetEmail
    const identifier = `impersonate:${adminEmail}:${email}`;
    
    // Clean up any existing tokens for this exact combo or expired tokens to prevent database bloat
    try {
      await prisma.verificationToken.deleteMany({
        where: {
          OR: [
            { identifier },
            { expires: { lt: new Date() } }
          ]
        }
      });
    } catch (_) {}

    await prisma.verificationToken.create({
      data: {
        identifier,
        token,
        expires,
      }
    });

    return NextResponse.json({ token });
  } catch (error: any) {
    console.error("Error creating impersonation token:", error);
    return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
  }
}
