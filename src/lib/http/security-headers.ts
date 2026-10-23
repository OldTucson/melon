type SecurityHeaderOptions = {
  allowUnsafeEval?: boolean;
};

export function createSecurityHeaders(
  options: SecurityHeaderOptions = {},
) {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  if (options.allowUnsafeEval) scriptSources.push("'unsafe-eval'");

  const contentSecurityPolicy = [
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "worker-src 'self' blob:",
  ].join("; ");

  return Object.freeze([
    Object.freeze({
      key: "Content-Security-Policy",
      value: contentSecurityPolicy,
    }),
    Object.freeze({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    }),
    Object.freeze({ key: "X-Content-Type-Options", value: "nosniff" }),
    Object.freeze({ key: "X-Frame-Options", value: "DENY" }),
    Object.freeze({ key: "Referrer-Policy", value: "no-referrer" }),
    Object.freeze({
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    }),
  ]);
}

export const SECURITY_HEADERS = createSecurityHeaders();
