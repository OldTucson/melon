const integerFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
  useGrouping: true,
});

const maxSafeChartInteger = BigInt(Number.MAX_SAFE_INTEGER);

export function formatFenCurrency(value: string) {
  const fen = BigInt(value);
  const negative = fen < 0n;
  const absolute = negative ? -fen : fen;
  const yuan = absolute / 100n;
  const remainder = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}¥${integerFormatter.format(yuan)}.${remainder}`;
}

export function safeFenToYuanNumber(value: string) {
  const fen = BigInt(value);
  if (fen > maxSafeChartInteger || fen < -maxSafeChartInteger) return null;
  return Number(fen) / 100;
}
