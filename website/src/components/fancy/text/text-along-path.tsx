"use client";

import { RefObject, useEffect, useRef } from "react";
import { useScroll, useTransform, type UseScrollOptions } from "motion/react";

type PreserveAspectRatioAlign =
  | "none"
  | "xMinYMin"
  | "xMidYMin"
  | "xMaxYMin"
  | "xMinYMid"
  | "xMidYMid"
  | "xMaxYMid"
  | "xMinYMax"
  | "xMidYMax"
  | "xMaxYMax";

type PreserveAspectRatioMeetOrSlice = "meet" | "slice";

type PreserveAspectRatio =
  | PreserveAspectRatioAlign
  | `${Exclude<PreserveAspectRatioAlign, "none">} ${PreserveAspectRatioMeetOrSlice}`;

export interface TextAlongPathProps {
  path: string;
  pathId?: string;
  pathClassName?: string;
  preserveAspectRatio?: PreserveAspectRatio;
  showPath?: boolean;

  width?: string | number;
  height?: string | number;
  viewBox?: string;
  svgClassName?: string;

  text: string;
  textClassName?: string;
  textAnchor?: "start" | "middle" | "end";

  animationType?: "auto" | "scroll";

  duration?: number;
  repeatCount?: number | "indefinite";
  easingFunction?: {
    calcMode?: string;
    keyTimes?: string;
    keySplines?: string;
  };

  scrollContainer?: RefObject<HTMLElement | null>;
  scrollOffset?: UseScrollOptions["offset"];
  scrollTransformValues?: [number, number];
}

export default function TextAlongPath({
  path,
  pathId,
  pathClassName,
  preserveAspectRatio = "xMidYMid meet",
  showPath = false,

  width = "100%",
  height = "100%",
  viewBox = "0 0 100 100",
  svgClassName,

  text,
  textClassName,
  textAnchor = "start",

  animationType = "auto",

  duration = 4,
  repeatCount = "indefinite",
  easingFunction = {},

  scrollContainer,
  scrollOffset = ["start end", "end end"],
  scrollTransformValues = [0, 100],
}: TextAlongPathProps) {
  const textPathRefs = useRef<SVGTextPathElement[]>([]);
  const id =
    pathId || `text-along-path-${Math.random().toString(36).substring(7)}`;

  const { scrollYProgress } = useScroll({
    ...(scrollContainer && { container: scrollContainer }),
    offset: scrollOffset,
  });

  const offsetValue = useTransform(
    scrollYProgress,
    [0, 1],
    scrollTransformValues
  );

  useEffect(() => {
    if (animationType !== "scroll" || !scrollContainer?.current) return;

    const updateOffset = () => {
      const value = offsetValue.get();
      textPathRefs.current.forEach((el) => {
        if (el) el.setAttribute("startOffset", `${value}%`);
      });
    };

    const unsubscribe = scrollYProgress.on("change", updateOffset);
    updateOffset();

    return () => unsubscribe();
  }, [animationType, scrollContainer, scrollYProgress, offsetValue]);

  const animationProps =
    animationType === "auto"
      ? {
          from: "0%",
          to: "100%",
          begin: "0s",
          dur: `${duration}s`,
          repeatCount,
          ...easingFunction,
        }
      : null;

  return (
    <svg
      className={svgClassName}
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      viewBox={viewBox}
      preserveAspectRatio={preserveAspectRatio}
    >
      <path
        id={id}
        className={pathClassName}
        d={path}
        stroke={showPath ? "currentColor" : "none"}
        fill="none"
      />

      <text textAnchor={textAnchor} fill="currentColor">
        <textPath
          className={textClassName}
          href={`#${id}`}
          startOffset={animationType === "auto" ? "0%" : "0%"}
          ref={(ref) => {
            if (ref) textPathRefs.current[0] = ref;
          }}
        >
          {animationType === "auto" && (
            <animate attributeName="startOffset" {...animationProps} />
          )}
          {text}
        </textPath>
      </text>

      {animationType === "auto" && (
        <text textAnchor={textAnchor} fill="currentColor">
          <textPath
            className={textClassName}
            href={`#${id}`}
            startOffset="-100%"
            ref={(ref) => {
              if (ref) textPathRefs.current[1] = ref;
            }}
          >
            <animate
              attributeName="startOffset"
              from="-100%"
              to="0%"
              begin="0s"
              dur={`${duration}s`}
              repeatCount={repeatCount}
              {...easingFunction}
            />
            {text}
          </textPath>
        </text>
      )}
    </svg>
  );
}
