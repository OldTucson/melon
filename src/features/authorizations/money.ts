import { AppError } from "@/lib/http/app-error";

const invalidPrice = (): never => {
  throw new AppError(
    "AUTHORIZATION_PRICE_INVALID",
    400,
    "Authorization price is invalid",
  );
};

export function parseRmbToFen(input: string): bigint {
  const normalized = input.trim();
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(normalized)) invalidPrice();

  const [yuan, fraction = ""] = normalized.split(".");
  return BigInt(yuan!) * 100n + BigInt(fraction.padEnd(2, "0"));
}

export function formatFen(value: bigint): string {
  if (value < 0n) invalidPrice();

  const yuan = value / 100n;
  const fen = (value % 100n).toString().padStart(2, "0");
  return `${yuan}.${fen}`;
}

