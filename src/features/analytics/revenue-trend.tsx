"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { DashboardDto } from "./contracts";
import { formatFenCurrency, safeFenToYuanNumber } from "./formatters";

export function RevenueTrend({ rows }: { rows: DashboardDto["trend"] }) {
  const chartData = rows.map((row) => ({
    ...row,
    revenueYuan: safeFenToYuanNumber(row.revenueFen),
  }));
  const chartSafe = chartData.every((row) => row.revenueYuan !== null);

  return (
    <figure className="dashboard-section dashboard-trend" aria-labelledby="revenue-trend-title">
      <div className="dashboard-section-heading">
        <div>
          <h2 id="revenue-trend-title">收入趋势</h2>
          <p>有效授权收入</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="dashboard-empty">所选期间暂无授权收入</div>
      ) : (
        <>
          {chartSafe ? (
            <div
              aria-hidden="true"
              className="dashboard-chart-visual"
              data-testid="revenue-line-chart"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 5" vertical={false} />
                  <XAxis
                    axisLine={false}
                    dataKey="bucket"
                    minTickGap={24}
                    tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                    tickLine={false}
                  />
                  <YAxis
                    axisLine={false}
                    tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                    tickFormatter={(value: number) => `¥${value.toLocaleString("zh-CN")}`}
                    tickLine={false}
                    width={76}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--surface-raised)",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      color: "var(--text)",
                      fontSize: 12,
                    }}
                    formatter={(_value, _name, item) => [
                      formatFenCurrency(String(item.payload.revenueFen)),
                      "收入",
                    ]}
                  />
                  <Line
                    dataKey="revenueYuan"
                    dot={{ fill: "var(--primary)", r: 3, strokeWidth: 0 }}
                    isAnimationActive={false}
                    stroke="var(--primary)"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="dashboard-chart-notice">图形数值超出安全显示范围</p>
          )}
          <div className="dashboard-table-scroll">
            <table className="dashboard-data-table" aria-label="收入趋势数据">
              <thead>
                <tr>
                  <th scope="col">期间</th>
                  <th scope="col">授权数</th>
                  <th scope="col">收入</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.bucket} tabIndex={0}>
                    <th scope="row">{row.bucket}</th>
                    <td>{row.count.toLocaleString("zh-CN")}</td>
                    <td>{formatFenCurrency(row.revenueFen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </figure>
  );
}
