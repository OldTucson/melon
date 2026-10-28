import Link from "next/link";

import type { DashboardDto } from "./contracts";
import { formatFenCurrency } from "./formatters";

export const fieldDrilldownHref = (fieldId: string) =>
  `/library?authorizationField=${encodeURIComponent(fieldId)}`;

export const patternDrilldownHref = (
  row: DashboardDto["topPatterns"][number],
) =>
  `${row.lifecycle === "trash" ? "/trash" : "/library"}?selected=${encodeURIComponent(row.patternId)}`;

export function FieldRanking({ rows }: { rows: DashboardDto["fields"] }) {
  return (
    <section
      aria-labelledby="field-ranking-title"
      className="dashboard-section dashboard-ranking"
    >
      <div className="dashboard-section-heading">
        <div>
          <h2 id="field-ranking-title">授权领域</h2>
          <p>按收入排序</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="dashboard-empty">暂无领域授权数据</div>
      ) : (
        <div className="dashboard-table-scroll">
          <table
            aria-label="授权领域排行"
            className="dashboard-data-table dashboard-ranking-table"
          >
            <thead>
              <tr>
                <th scope="col">领域</th>
                <th scope="col">授权数</th>
                <th scope="col">收入</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.fieldId}>
                  <th scope="row">
                    <Link href={fieldDrilldownHref(row.fieldId)}>{row.fieldName}</Link>
                  </th>
                  <td>{row.count.toLocaleString("zh-CN")}</td>
                  <td>{formatFenCurrency(row.revenueFen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function PatternRanking({
  rows,
}: {
  rows: DashboardDto["topPatterns"];
}) {
  return (
    <section
      aria-labelledby="pattern-ranking-title"
      className="dashboard-section dashboard-ranking"
    >
      <div className="dashboard-section-heading">
        <div>
          <h2 id="pattern-ranking-title">授权图案</h2>
          <p>按收入排序</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="dashboard-empty">暂无图案授权数据</div>
      ) : (
        <div className="dashboard-table-scroll">
          <table
            aria-label="授权图案排行"
            className="dashboard-data-table dashboard-ranking-table"
          >
            <thead>
              <tr>
                <th scope="col">图案</th>
                <th scope="col">授权数</th>
                <th scope="col">收入</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.patternId}>
                  <th scope="row">
                    <Link href={patternDrilldownHref(row)}>
                      <span>{row.patternName}</span>
                      <small>{row.lifecycle === "trash" ? "回收站" : "图库"}</small>
                    </Link>
                  </th>
                  <td>{row.count.toLocaleString("zh-CN")}</td>
                  <td>{formatFenCurrency(row.revenueFen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
