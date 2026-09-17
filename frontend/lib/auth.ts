import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { assertLoginAllowed, clearLoginFailures, recordLoginFailure } from "@/lib/loginRateLimit";
import { getAccountByEmail, getAccountById } from "@/lib/accountCache";

import { getToken } from "next-auth/jwt";

// bcrypt hash of a random throw-away string, compared when an account doesn't exist
const DUMMY_PASSWORD_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.v6l4H1s1VzO9t4Xh/0lWmoI3uH6m";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "User ID", type: "text" },
        password: { label: "Password", type: "password" },
        accountType: { label: "Account Type", type: "text" },
        impersonate: { label: "Impersonate", type: "text" },
        revertImpersonation: { label: "Revert Impersonation", type: "text" },
        token: { label: "Token", type: "text" },
      },
      async authorize(credentials, req) {
        const parseCookies = (cookieString: string) => {
          const cookies: Record<string, string> = {};
          if (!cookieString) return cookies;
          cookieString.split(";").forEach(cookie => {
            const parts = cookie.split("=");
            const name = parts[0].trim();
            const value = parts.slice(1).join("=");
            if (name) cookies[name] = value;
          });
          return cookies;
        };

        // Helper to reliably extract the token
        const getSessionToken = async () => {
           const cookieHeader = (req as any)?.headers?.cookie || "";
           const parsedCookies = parseCookies(cookieHeader);
           return await getToken({ 
             req: { 
               headers: { cookie: cookieHeader },
               cookies: parsedCookies
             } as any, 
             secret: process.env.NEXTAUTH_SECRET 
           });
        };

        // Handle Return to Admin
        if (credentials?.revertImpersonation === 'true') {
           
           const token = await getSessionToken();

           if (!token) {
              console.error("[Revert] Error: No session token found in request cookies");
              throw new Error("No original admin session to return to");
           }
           if (!token.originalAdminEmail) {
              console.error("[Revert] No originalAdminEmail in session token");
              throw new Error("No original admin session to return to");
           }
           
           const adminUser = await prisma.user.findUnique({ where: { email: token.originalAdminEmail as string } });

           if (!adminUser) {
              console.error("[Revert] Error: original administrator account not found");
              throw new Error("Admin user not found");
           }
           if (adminUser.accountType?.toLowerCase() !== "administrator" || !adminUser.isActive) {
              console.error("[Revert] Error: original account is no longer an Administrator");
              throw new Error("Admin user not found or invalid");
           }
           
           return {
              id: adminUser.id,
              email: adminUser.email,
              name: adminUser.name,
              image: adminUser.image,
              accountType: adminUser.accountType,
           };
        }

        // Handle Impersonation
        if (credentials?.impersonate === 'true') {
           let isAuthorized = false;
           let originalAdminEmail = "";

           // 1. Try to authorize via single-use database token
           if (credentials?.token) {
              const dbToken = await prisma.verificationToken.findUnique({
                where: { token: credentials.token }
              });

              if (dbToken && dbToken.expires >= new Date()) {
                 const parts = dbToken.identifier.split(":");
                 if (parts[0] === "impersonate" && parts[2] === credentials?.email) {
                    isAuthorized = true;
                    originalAdminEmail = parts[1];
                    
                    // Consume the single-use token immediately
                    try {
                      await prisma.verificationToken.delete({
                        where: { token: dbToken.token }
                      });
                    } catch (e) {
                      console.error("Failed to delete used impersonation token:", e);
                    }
                 }
              }
           }

           // 2. Fall back to standard session cookie validation
           if (!isAuthorized) {
              const token = await getSessionToken();
              const isOriginalAdmin = token && token.originalAdminEmail;
              if (token && (token.accountType === "Administrator" || isOriginalAdmin)) {
                 isAuthorized = true;
                 originalAdminEmail = (token.originalAdminEmail || token.email) as string;
              }
           }

           // The session cookie alone is not trusted: the admin must still be an active Administrator
           if (isAuthorized) {
              const admin = originalAdminEmail
                ? await prisma.user.findUnique({ where: { email: originalAdminEmail } })
                : null;
              isAuthorized = !!admin && admin.accountType === "Administrator" && admin.isActive;
           }

           if (!isAuthorized) {
              throw new Error("Only administrators can impersonate accounts");
           }
           
           const user = await prisma.user.findUnique({
             where: { email: credentials?.email },
           });
           if (!user) throw new Error("User not found");
           if (user.accountType === "Administrator") throw new Error("Administrator accounts cannot be accessed");
           if (!user.isActive) throw new Error("This account is deactivated");

           return {
              id: user.id,
              email: user.email,
              name: user.name,
              image: user.image,
              accountType: user.accountType || "Customer",
              originalAdminEmail: originalAdminEmail // Store/preserve the admin's email!
           };
        }

        if (!credentials?.email || !credentials?.password || !credentials?.accountType) {
          throw new Error("User ID, password, and account type are required");
        }

        const email = credentials.email.trim().toLowerCase();
        // Throttle repeated failures per account + client IP to slow down password guessing
        // (keyed by IP too, so nobody can lock a colleague out from another machine)
        const forwarded = (req as any)?.headers?.["x-forwarded-for"];
        const clientIp = String(Array.isArray(forwarded) ? forwarded[0] : forwarded || "").split(",")[0].trim() || "unknown";
        const limitKey = `login:${email}:${clientIp}`;
        // The forwarded IP can be spoofed, so each account also has an overall limit
        const accountKey = `login-account:${email}`;
        assertLoginAllowed(limitKey);
        assertLoginAllowed(accountKey, 30);

        const user = await prisma.user.findUnique({
          where: { email },
        });

        // Always run bcrypt (against a dummy hash for unknown accounts) so response time and
        // messages don't reveal which accounts exist
        const isValid = await bcrypt.compare(credentials.password, user?.password || DUMMY_PASSWORD_HASH);
        if (!user || !user.password || !isValid) {
          recordLoginFailure(limitKey);
          recordLoginFailure(accountKey);
          throw new Error("Invalid User ID or password");
        }

        // Only tell the owner (correct password) that the account is deactivated
        if (!user.isActive) {
          throw new Error("This account is deactivated");
        }
        clearLoginFailures(limitKey);
        clearLoginFailures(accountKey);

        // Compare account types (case-insensitive for safety)
        const dbRole = user.accountType || "Customer";
        const selectedRole = credentials.accountType;
        if (dbRole.toLowerCase() !== selectedRole.toLowerCase()) {
          throw new Error("Invalid User ID, password, or account type");
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          accountType: dbRole,
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
    // Staff sign in again after 12 hours; active sessions are refreshed while in use
    maxAge: 12 * 60 * 60,
    updateAge: 60 * 60,
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.accountType = (user as any).accountType;
        if ((user as any).originalAdminEmail) {
           token.originalAdminEmail = (user as any).originalAdminEmail;
        } else {
           delete token.originalAdminEmail; // ensure it's cleared on normal login
        }
        return token;
      }

      // Re-check the account on every session read so deactivated, deleted or
      // re-assigned users lose access immediately. Throwing clears the session cookie.
      const current = await getAccountById(token.id as string);
      if (!current || !current.isActive) {
        throw new Error("Account no longer active");
      }
      token.accountType = current.accountType;

      if (token.originalAdminEmail) {
        // An administrator who was deactivated, deleted or demoted while logged in as another
        // user loses that session too
        const admin = await getAccountByEmail(token.originalAdminEmail as string);
        if (admin?.accountType !== "Administrator" || !admin.isActive) {
          throw new Error("Administrator account no longer active");
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id as string;
        (session.user as any).accountType = token.accountType as string;
        if (token.originalAdminEmail) {
           (session.user as any).originalAdminEmail = token.originalAdminEmail;
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
