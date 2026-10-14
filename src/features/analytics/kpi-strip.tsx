import { CircleDollarSign, FileImage, ReceiptText, Sigma } from "lucide-react";

import type { DashboardDto } from "./contracts";
import { formatFenCurrency } from "./formatters";

export function KpiStrip({ metrics }: { metrics: DashboardDto["metrics"] }) {
  const items = [
    {
      label: "授权收入",
      value: formatFenCurrency(metrics.revenueFen),
      icon: CircleDollarSign,
      comparison:
        metrics.comparisonPercent === null
          ? null
          : `较上期 ${Number(metrics.comparisonPercent) >= 0 ? "+" : ""}${metrics.comparisonPercent}%`,
    },
    {
      label: "有效授权",
      value: metrics.count.toLocaleString("zh-CN"),
      icon: ReceiptText,
      comparison: null,
    },
    {
      label: "授权图案",
      value: metrics.patternCount.toLocaleString("zh-CN"),
      icon: FileImage,
      comparison: null,
    },
    {
      label: "平均授权价",
      value: formatFenCurrency(metrics.averageFen),
      icon: Sigma,
      comparison: null,
    },
  ];

  return (
    <section className="dashboard-kpis" aria-label="商业授权关键指标">
      {items.map(({ label, value, icon: Icon, comparison }) => (
        <div className="dashboard-kpi" key={label}>
          <div className="dashboard-kpi-label">
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </div>
          <strong>{value}</strong>
          {comparison ? <small>{comparison}</small> : null}
        </div>
      ))}
    </section>
  );
}
