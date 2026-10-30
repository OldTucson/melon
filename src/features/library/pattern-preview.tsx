"use client";

/* eslint-disable @next/next/no-img-element */

import {
  Download,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PatternItem } from "./library-types";
import { IconButton } from "./icon-button";
import { FormatPlaceholder } from "./pattern-card";

export function PatternPreview({ pattern }: { pattern: PatternItem }) {
  const [failed, setFailed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [viewport, setViewport] = useState({ height: 0, width: 0 });
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const hasPreview = Boolean(pattern.previewAssetId && !failed);
  const quarterTurn = rotation % 180 !== 0;
  const imageHeight = quarterTurn ? viewport.width : viewport.height;
  const imageWidth = quarterTurn ? viewport.height : viewport.width;
  const canvasHeight = viewport.height * Math.max(1, zoom);
  const canvasWidth = viewport.width * Math.max(1, zoom);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const updateViewport = (width: number, height: number) => {
      const next = {
        height: Math.max(0, Math.round(height)),
        width: Math.max(0, Math.round(width)),
      };
      setViewport((current) =>
        current.height === next.height && current.width === next.width
          ? current
          : next,
      );
    };

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        updateViewport(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || viewport.width === 0 || viewport.height === 0) return;
    const frame = requestAnimationFrame(() => {
      stage.scrollLeft = Math.max(
        0,
        (stage.scrollWidth - stage.clientWidth) / 2,
      );
      stage.scrollTop = Math.max(
        0,
        (stage.scrollHeight - stage.clientHeight) / 2,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [rotation, viewport.height, viewport.width, zoom]);

  const setClampedZoom = (next: number) => {
    setZoom(Math.min(4, Math.max(0.25, next)));
  };

  const measured = viewport.width > 0 && viewport.height > 0;

  return (
    <>
      <div
        className="preview-stage"
        data-rotation={rotation}
        data-zoom={zoom}
        ref={stageRef}
      >
        <div
          className="preview-canvas"
          style={
            measured
              ? { height: `${canvasHeight}px`, width: `${canvasWidth}px` }
              : undefined
          }
        >
          {hasPreview ? (
            <img
              alt={`${pattern.name} 预览图`}
              src={`/api/assets/${pattern.previewAssetId}/view`}
              onError={() => setFailed(true)}
              style={{
                height: measured ? `${imageHeight}px` : "100%",
                transform: `translate(-50%, -50%) rotate(${rotation}deg) scale(${zoom})`,
                width: measured ? `${imageWidth}px` : "100%",
              }}
            />
          ) : (
            <FormatPlaceholder
              extension={pattern.extension}
              previewStatus={pattern.previewStatus}
            />
          )}
        </div>
      </div>
      <footer className="preview-footer">
        {hasPreview ? (
          <div className="preview-controls" aria-label="预览控制">
            <IconButton
              disabled={zoom <= 0.25}
              label="缩小"
              onClick={() => setClampedZoom(zoom - 0.25)}
            >
              <ZoomOut aria-hidden="true" />
            </IconButton>
            <output aria-label="当前缩放比例" className="preview-zoom">
              {Math.round(zoom * 100)}%
            </output>
            <IconButton
              disabled={zoom >= 4}
              label="放大"
              onClick={() => setClampedZoom(zoom + 0.25)}
            >
              <ZoomIn aria-hidden="true" />
            </IconButton>
            <IconButton label="适应窗口" onClick={() => setZoom(1)}>
              <Maximize2 aria-hidden="true" />
            </IconButton>
            <IconButton
              label="顺时针旋转 90°"
              onClick={() => setRotation((current) => (current + 90) % 360)}
            >
              <RotateCw aria-hidden="true" />
            </IconButton>
          </div>
        ) : (
          <span />
        )}
        {pattern.sourceAssetId ? (
          <a
            className="secondary-button"
            href={`/api/assets/${pattern.sourceAssetId}/download`}
          >
            <Download aria-hidden="true" />
            下载原文件
          </a>
        ) : null}
      </footer>
    </>
  );
}
