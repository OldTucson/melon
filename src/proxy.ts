import { type NextRequest, NextResponse } from "next/server";

const protectedPath =
  /^\/(library|dashboard|trash|settings|inspiration)(?:\/|$)/;
const sessionCookieNames = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
] as const;

export function proxy(request: NextRequest) {
  if (!protectedPath.test(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const hasSessionCookie = sessionCookieNames.some((name) =>
    request.cookies.has(name),
  );

  if (!hasSessionCookie) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/library/:path*",
    "/dashboard/:path*",
    "/trash/:path*",
    "/settings/:path*",
    "/inspiration/:path*",
  ],
};
