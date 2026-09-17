import { withAuth } from "next-auth/middleware";

import { NextResponse, type NextRequest } from "next/server";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Blocks state-changing API calls sent by another website (cross-site request forgery). */
function isCrossSiteWrite(req: NextRequest) {
  if (SAFE_METHODS.has(req.method)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return false; // browsers always send Origin on cross-site writes
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export default withAuth(
  function middleware(req) {
    const path = req.nextUrl.pathname;

    // The app never uses next/image. Its optimizer endpoint is disabled because of known
    // vulnerabilities in the Image Optimization API of Next.js 14.
    if (path.startsWith("/_next/image")) {
      return new NextResponse(null, { status: 404 });
    }

    if (path.startsWith("/api/")) {
      if (isCrossSiteWrite(req)) {
        return NextResponse.json({ message: "Cross-site request blocked" }, { status: 403 });
      }
      return NextResponse.next();
    }

    const res = NextResponse.next();
    // Prevent browser bfcache from showing protected pages after logout
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return res;
  },
  {
    callbacks: {
      // Admin pages require an Administrator; other pages just need a login.
      // API routes check the session and roles themselves.
      authorized: ({ token, req }) => {
        const path = req.nextUrl.pathname;
        if (path.startsWith("/_next/image") || path.startsWith("/api/")) return true;
        // An admin who is logged in as another user may still switch to a different account
        if (path.startsWith("/admin/impersonate")) {
          return token?.accountType === "Administrator" || !!token?.originalAdminEmail;
        }
        return path.startsWith("/admin") ? token?.accountType === "Administrator" : !!token;
      },
    },
    pages: {
      signIn: "/auth/signin",
    },
  }
);

export const config = {
  matcher: [
    "/_next/image",
    "/api/:path*",
    /*
     * Protect all page routes EXCEPT:
     * - api (matched above; routes enforce their own session and role checks)
     * - auth/ (login and register pages)
     * - _next/static, _next/image (build assets; _next/image is matched above)
     * - models/, images/, hdri/ (public 3D models, images and lighting)
     * - static file extensions
     */
    "/((?!api/|auth/|_next/static|_next/image|models/|images/|hdri/|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|obj|glb|gltf|bin|mtl|hdr|json|woff2?)$).*)",
  ],
};
