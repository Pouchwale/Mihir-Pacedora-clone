import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ACCOUNT_TYPES } from "@/lib/access";
import { readJson } from "@/lib/http";
import { invalidateAccounts } from "@/lib/accountCache";

/** True when this user is the only remaining active Administrator. */
async function isLastActiveAdmin(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: { accountType: true, isActive: true } });
  if (user?.accountType !== "Administrator" || !user.isActive) return false;
  const activeAdmins = await prisma.user.count({ where: { accountType: "Administrator", isActive: true } });
  return activeAdmins <= 1;
}

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user as any)?.accountType !== "Administrator") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        email: true,
        accountType: true,
        createdAt: true,
        isActive: true,
      },
    });

    return NextResponse.json(users);
  } catch (error: any) {
    console.error("GET users error:", error);
    return NextResponse.json(
      { message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

import bcrypt from "bcryptjs";

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user as any)?.accountType !== "Administrator") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const parsed = await readJson(req, 16 * 1024);
    if (parsed.error) return parsed.error;
    const { id, newPassword, isActive, accountType } = parsed.body;
    if (typeof id !== "string" || (newPassword !== undefined && typeof newPassword !== "string") ||
        (isActive !== undefined && typeof isActive !== "boolean") || (newPassword && newPassword.length > 200)) {
      return NextResponse.json({ message: "Invalid request" }, { status: 400 });
    }

    if (!id) {
      return NextResponse.json({ message: "User ID is required" }, { status: 400 });
    }

    let updateData: any = {};
    if (id === (session.user as any)?.id && isActive === false) {
      return NextResponse.json({ message: "You cannot deactivate your own account" }, { status: 400 });
    }

    if (accountType !== undefined) {
      if (!(ACCOUNT_TYPES as readonly string[]).includes(accountType)) {
        return NextResponse.json({ message: "Invalid account type" }, { status: 400 });
      }
      if (id === (session.user as any)?.id) {
        return NextResponse.json({ message: "You cannot change your own account type" }, { status: 400 });
      }
    }

    if (newPassword !== undefined && String(newPassword).length < 8) {
      return NextResponse.json({ message: "Password must be at least 8 characters" }, { status: 400 });
    }

    if (newPassword) {
      updateData.password = await bcrypt.hash(newPassword, 12);
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }
    if (accountType !== undefined) {
      updateData.accountType = accountType;
    }

    const demotesAdmin =
      updateData.isActive === false || (updateData.accountType !== undefined && updateData.accountType !== "Administrator");
    if (demotesAdmin && (await isLastActiveAdmin(id))) {
      return NextResponse.json({ message: "At least one active Administrator is required" }, { status: 400 });
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ message: "No updates provided" }, { status: 400 });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        name: true,
        email: true,
        accountType: true,
        isActive: true,
      },
    });

    invalidateAccounts();
    return NextResponse.json({ message: "User updated successfully", user: updatedUser });
  } catch (error: any) {
    console.error("PATCH user error:", error);
    return NextResponse.json(
      { message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || (session.user as any)?.accountType !== "Administrator") {
      return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ message: "User ID is required" }, { status: 400 });
    }

    if (id === (session.user as any)?.id) {
      return NextResponse.json({ message: "You cannot delete your own account" }, { status: 400 });
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) {
      return NextResponse.json({ message: "User not found" }, { status: 404 });
    }
    if (await isLastActiveAdmin(id)) {
      return NextResponse.json({ message: "At least one active Administrator is required" }, { status: 400 });
    }

    await prisma.user.delete({
      where: { id },
    });
    invalidateAccounts();

    return NextResponse.json({ message: "User deleted successfully" });
  } catch (error: any) {
    console.error("DELETE user error:", error);
    return NextResponse.json(
      { message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
