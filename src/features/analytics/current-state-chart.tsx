"use client";

import Link from "next/link";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import type { CommercialState, DashboardDto } from "./contracts";

const statePresentation: Record<
  CommercialState,
  { label: string; color: string }
> = {
  unlicensed: { label: "未授权", color: "var(--text-muted)" },
  standard: { label: "普通授权", color: "var(--status-standard)" },
  field_exclusive: { label: "领域独占", color: "var(--status-exclusive)" },
  global_buyout: { label: "全局买断", color: "var(--status-buyout)" },
};

export function CurrentStateChart({
  rows,
}: {
  rows: DashboardDto["currentStates"];
}) {
  const total = rows.reduce((sum, row) => sum + row.patternCount, 0);
  const chartData = rows.filter((row) => row.patternCount > 0);

  return (
    <section className="dashboard-section dashboard-state" aria-labelledby="current-state-title">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="current-state-title">当前商业状态</h2>
          <p>截至今日的图库图案</p>
        </div>
        <strong>{total.toLocaleString("zh-CN")}</strong>
      </div>
      {total > 0 ? (
        <div aria-hidden="true" className="dashboard-state-chart">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="patternCount"
                innerRadius={48}
                isAnimationActive={false}
                nameKey="state"
                outerRadius={72}
                paddingAngle={2}
                stroke="var(--surface)"
                strokeWidth={2}
              >
                {chartData.map((row) => (
                  <Cell
                    fill={statePresentation[row.state].color}
                    key={row.state}
                  />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <span>{total.toLocaleString("zh-CN")}</span>
        </div>
      ) : (
        <div className="dashboard-empty dashboard-state-empty">图库暂无图案</div>
      )}
      <ul className="dashboard-state-list" aria-label="当前商业状态数据">
        {rows.map((row) => {
          const presentation = statePresentation[row.state];
          return (
            <li key={row.state}>
              <Link href={`/library?commercialState=${row.state}`}>
                <span
                  aria-hidden="true"
                  className="dashboard-state-swatch"
                  style={{ background: presentation.color }}
                />
                <span>{presentation.label}</span>
                <strong>{row.patternCount.toLocaleString("zh-CN")}</strong>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
