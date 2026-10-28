import type { ReactNode } from "react";

import type { InspirationPrompt } from "./contracts";
import styles from "./inspiration.module.css";

const hexColor = /^#[\dA-F]{6}$/i;

export type InspirationDirectionListProps = {
  directions: InspirationPrompt[];
  renderSources: (sourceIndexes: number[]) => ReactNode;
};

export function InspirationDirectionList({
  directions,
  renderSources,
}: InspirationDirectionListProps) {
  return (
    <section className={styles.directionSection} aria-label="设计灵感">
      <h3>设计灵感 · 设计推演</h3>
      <ol className={styles.directionList}>
        {directions.map((direction, index) => (
          <li className={styles.directionRow} key={`${direction.title}-${index}`}>
            <span className={styles.directionIndex} aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className={styles.directionBody}>
              <h4>{direction.title}</h4>
              <p>{direction.direction}</p>
              <dl className={styles.directionDetails}>
                <div>
                  <dt>廓形</dt>
                  <dd>{direction.silhouette}</dd>
                </div>
                <div>
                  <dt>配色</dt>
                  <dd className={styles.directionPalette}>
                    {direction.palette.length
                      ? direction.palette.map((color) => (
                          <span key={color}>
                            {hexColor.test(color) && (
                              <span
                                className={styles.miniSwatch}
                                role="img"
                                aria-label={color}
                                style={{ backgroundColor: color }}
                              />
                            )}
                            {color}
                          </span>
                        ))
                      : "未指定"}
                  </dd>
                </div>
                <div>
                  <dt>材质</dt>
                  <dd>{direction.materials.join("、") || "未指定"}</dd>
                </div>
                <div>
                  <dt>细节</dt>
                  <dd>{direction.details.join("、") || "未指定"}</dd>
                </div>
              </dl>
              {renderSources(direction.sourceIndexes)}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
