import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { ACCOUNT_TYPES } from "@/lib/access";
import { readJson } from "@/lib/http";

export async function POST(req: NextRequest) {
  try {
    // Only administrators may create accounts. The first administrator is created by the
    // deploy seed (ADMIN_EMAIL / ADMIN_PASSWORD), never through this public endpoint.
    const session = await getServerSession(authOptions);
    const isAdmin = (session?.user as any)?.accountType === "Administrator";
    if (!isAdmin) {
      return NextResponse.json(
        { message: "Only administrators can create new accounts." },
        { status: 403 }
      );
    }

    const parsed = await readJson(req, 16 * 1024);
    if (parsed.error) return parsed.error;
    const body = parsed.body;
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const accountType = body.accountType || "Customer";

    if (!email || !password || !name) {
      return NextResponse.json(
        { message: "Name, email, and password are required" },
        { status: 400 }
      );
    }
    if (name.length > 120 || email.length > 254 || password.length > 200 || !/^[^\s@]+@[^\s@]+$|^[a-z0-9._-]+$/i.test(email)) {
      return NextResponse.json({ message: "Invalid name, email or password" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json(
        { message: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }
    if (!ACCOUNT_TYPES.includes(accountType)) {
      return NextResponse.json({ message: "Invalid account type" }, { status: 400 });
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { message: "User with this email already exists" },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        accountType,
      },
      select: {
        id: true,
        name: true,
        email: true,
        accountType: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      { message: "User registered successfully", user },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
