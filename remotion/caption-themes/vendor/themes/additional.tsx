import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { InternalThemeProps, WordTiming } from "../types";

type LayoutFamily =
  | "poster"
  | "stair"
  | "arc"
  | "columns"
  | "ledger"
  | "mosaic"
  | "ribbon"
  | "orbit"
  | "bracket"
  | "stencil";

interface CompositionSpec {
  id: string;
  family: LayoutFamily;
  variant: number;
}

const SPECS: CompositionSpec[] = [
  { id: "poster-stack", family: "poster", variant: 0 },
  { id: "news-poster", family: "poster", variant: 1 },
  { id: "cut-poster", family: "poster", variant: 2 },
  { id: "staircase", family: "stair", variant: 0 },
  { id: "split-column", family: "columns", variant: 0 },
  { id: "editorial-columns", family: "columns", variant: 1 },
  { id: "timestamp-ledger", family: "ledger", variant: 1 },
  { id: "split-bracket", family: "bracket", variant: 2 },
];

function wordsFrom(data: InternalThemeProps["data"]): WordTiming[] {
  return data.lines.flatMap((line) => line.words);
}

function phrase(words: WordTiming[], from: number, to: number): string {
  return words.slice(from, to).map((word) => word.text).join(" ");
}

function progressFor(words: WordTiming[], time: number): number {
  const index = words.findIndex((word) => time >= word.start && time <= word.end);
  if (index < 0) return time < words[0].start ? 0 : 1;
  const word = words[index];
  const local = interpolate(
    time,
    [word.start, Math.max(word.start + 0.04, word.end)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (index + local) / words.length;
}

const ROW_ALIGNMENT = ["left", "right", "left", "center"] as const;
const ROW_SIZE = [1, 0.86, 1.08, 0.94] as const;

function renderPoster(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
) {
  const splitAt = Math.ceil(words.length / 2);
  const rows = [words.slice(0, splitAt), words.slice(splitAt)].filter(
    (row) => row.length > 0,
  );
  const aligns = ["left", "center", "right", "left"] as const;
  const align = aligns[variant];

  return (
    <div
      style={{
        width: "90%",
        maxWidth: `${950 * scale}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
        gap: `${variant === 1 ? 14 : 3}px`,
        textAlign: align,
        padding: `${variant === 2 ? 18 * scale : 0}px`,
        background:
          variant === 1
            ? `linear-gradient(90deg, ${accent} 0 ${5 * scale}px, transparent ${5 * scale}px)`
            : variant === 2
              ? `linear-gradient(135deg, ${accent} 0 8%, transparent 8% 100%)`
              : "transparent",
      }}
    >
      {rows.map((row, rowIndex) => (
        <div
          key={`poster-${rowIndex}`}
          style={{
            color: primary,
            fontFamily: variant === 1 ? '"Montserrat", sans-serif' : '"Outfit", sans-serif',
            fontSize: `${size * (rowIndex === 0 ? 1.06 : 0.88)}px`,
            fontWeight: rowIndex === 0 ? 900 : 800,
            lineHeight: variant === 3 ? 0.92 : 1.02,
            textTransform: "uppercase",
            textWrap: "balance",
            textShadow:
              variant === 2 ? `${3 * scale}px ${3 * scale}px 0 ${accent}` : "none",
            transform:
              variant === 2 && rowIndex === 0
                ? `translateX(${8 * scale}px) rotate(-1deg)`
                : "none",
          }}
        >
          {row.map((word, index) => (
            <React.Fragment key={`${word.start}-${index}`}>
              {word.text}{index < row.length - 1 ? " " : ""}
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

function renderStair(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  frame: number,
  fps: number,
) {
  const direction = variant === 2 ? -1 : 1;
  const align = variant === 1 ? "flex-start" : variant === 2 ? "flex-end" : "center";
  return (
    <div
      style={{
        width: "88%",
        maxWidth: `${930 * scale}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: align,
        gap: `${variant === 3 ? 0 : 4 * scale}px`,
        textAlign: variant === 1 ? "left" : variant === 2 ? "right" : "center",
      }}
    >
      {words.map((word, index) => {
        const enter = spring({
          frame: frame - Math.round(words[0].start * fps),
          fps,
          config: { damping: 18, stiffness: 130, mass: 0.8 },
        });
        const indent = ((index + variant) % 3) * size * 0.22 * direction;
        const isFocal = index === Math.floor(words.length / 2);
        return (
          <div
            key={`${word.start}-${index}`}
            style={{
              color: isFocal && variant === 3 ? accent : primary,
              fontFamily: variant === 1 ? '"Rajdhani", sans-serif' : '"Outfit", sans-serif',
              fontSize: `${size * (isFocal ? 1.08 : ROW_SIZE[variant])}px`,
              fontWeight: isFocal ? 900 : 750,
              lineHeight: 0.88,
              textTransform: "uppercase",
              whiteSpace: "nowrap",
              translate: `${indent * enter}px ${(1 - enter) * 20 * scale}px`,
              opacity: enter,
              textShadow:
                variant === 3 && isFocal
                  ? `${3 * scale}px ${3 * scale}px 0 ${primary}`
                  : "0 4px 18px rgba(0,0,0,0.28)",
            }}
          >
            {word.text}
          </div>
        );
      })}
    </div>
  );
}

function renderArc(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  const curve = [1, -1, 0.7, -0.65][variant];
  return (
    <div
      style={{
        width: "94%",
        maxWidth: `${980 * scale}px`,
        minHeight: `${150 * scale}px`,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        columnGap: `${size * 0.12}px`,
        rowGap: `${size * 0.04}px`,
        perspective: `${900 * scale}px`,
      }}
    >
      {words.map((word, index) => {
        const center = (words.length - 1) / 2;
        const distance = index - center;
        const rotate = distance * (variant === 2 ? -8 : 7);
        const lift = (distance * distance * curve * -7 + (variant === 3 ? distance * 6 : 0)) * scale;
        const isProgressed = index / Math.max(1, words.length - 1) <= progress;
        return (
          <span
            key={`${word.start}-${index}`}
            style={{
              color: primary,
              fontFamily: variant === 1 ? '"Rajdhani", sans-serif' : '"Montserrat", sans-serif',
              fontSize: `${size * (variant === 3 && index === Math.floor(center) ? 1.18 : 0.88)}px`,
              fontWeight: 900,
              lineHeight: 1,
              textTransform: "uppercase",
              display: "inline-block",
              rotate: `${rotate}deg`,
              translate: `0px ${lift}px`,
              textShadow: isProgressed
                ? `0 ${4 * scale}px ${variant === 0 ? 20 : 10 * scale}px ${accent}88`
                : `0 ${3 * scale}px 0 rgba(0,0,0,0.3)`,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
}

function renderColumns(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  const splitAt = Math.ceil(words.length / 2);
  const columns = [words.slice(0, splitAt), words.slice(splitAt)];
  const reverse = variant === 2 || variant === 3;
  return (
    <div
      style={{
        width: "88%",
        maxWidth: `${930 * scale}px`,
        display: "grid",
        gridTemplateColumns: variant === 3 ? "1fr 1.25fr" : "1fr 1fr",
        columnGap: `${24 * scale}px`,
        alignItems: "center",
        direction: reverse ? "rtl" : "ltr",
      }}
    >
      {columns.map((column, columnIndex) => (
        <div
          key={`column-${columnIndex}`}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: `${variant === 1 ? 16 : 8 * scale}px`,
            direction: "ltr",
            textAlign: variant === 2 && columnIndex === 0 ? "right" : "left",
            borderTop:
              variant === 1 ? `${3 * scale}px solid ${accent}` : "none",
            paddingTop: variant === 1 ? `${10 * scale}px` : 0,
          }}
        >
          {column.map((word, index) => {
            const globalIndex = columnIndex * splitAt + index;
            const passed = globalIndex / Math.max(1, words.length - 1) <= progress;
            return (
              <div
                key={`${word.start}-${index}`}
                style={{
                  color: primary,
                  fontFamily: variant === 1 ? '"Outfit", sans-serif' : '"Montserrat", sans-serif',
                  fontSize: `${size * (variant === 3 && index === 0 ? 1.08 : 0.68)}px`,
                  fontWeight: 800,
                  lineHeight: 0.94,
                  textTransform: "uppercase",
                  borderLeft:
                    variant === 0 && passed ? `${4 * scale}px solid ${accent}` : "none",
                  paddingLeft: variant === 0 ? `${8 * scale}px` : 0,
                  opacity: variant === 2 && !passed ? 0.64 : 1,
                }}
              >
                {word.text}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function renderLedger(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  return (
    <div
      style={{
        width: "88%",
        maxWidth: `${900 * scale}px`,
        display: "flex",
        flexDirection: "column",
        borderTop: `${2 * scale}px solid ${accent}`,
        textAlign: variant === 3 ? "center" : "left",
      }}
    >
      {words.map((word, index) => {
        const passed = index / Math.max(1, words.length - 1) <= progress;
        const number = variant === 1
          ? `${String(Math.floor(word.start / 60)).padStart(2, "0")}:${String(Math.floor(word.start % 60)).padStart(2, "0")}`
          : String(index + 1).padStart(2, "0");
        return (
          <div
            key={`${word.start}-${index}`}
            style={{
              display: "grid",
              gridTemplateColumns: variant === 2 ? `${size * 0.5}px 1fr` : `${size * 0.9}px 1fr`,
              alignItems: "baseline",
              gap: `${10 * scale}px`,
              padding: `${4 * scale}px 0`,
              borderBottom: `${1 * scale}px solid rgba(255,255,255,0.28)`,
              color: primary,
              fontFamily: variant === 3 ? '"Outfit", sans-serif' : '"Rajdhani", sans-serif',
              fontSize: `${size * (variant === 3 ? 0.74 : 0.62)}px`,
              fontWeight: 800,
              lineHeight: 0.94,
              textTransform: "uppercase",
              opacity: passed ? 1 : 0.76,
            }}
          >
            <span
              style={{
                color: accent,
                fontSize: `${size * 0.22}px`,
                fontWeight: 700,
                letterSpacing: `${1.5 * scale}px`,
              }}
            >
              {number}
            </span>
            <span>{word.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function renderMosaic(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
) {
  const focalIndex = words.reduce((best, word, index) =>
    word.text.length > words[best].text.length ? index : best, 0);
  const focal = words[focalIndex];
  const rest = words.filter((_, index) => index !== focalIndex);
  return (
    <div
      style={{
        width: "90%",
        maxWidth: `${920 * scale}px`,
        display: "grid",
        gridTemplateColumns: variant === 2 ? "0.75fr 1.25fr" : "1fr 1fr",
        alignItems: "center",
        gap: `${12 * scale}px ${20 * scale}px`,
      }}
    >
      <div
        style={{
          gridColumn: variant === 1 ? "2" : "1",
          gridRow: "1 / span 2",
          color: primary,
          fontFamily: '"Outfit", sans-serif',
          fontSize: `${size * (variant === 3 ? 1.32 : 1.52)}px`,
          fontWeight: 900,
          lineHeight: 0.84,
          textAlign: variant % 2 ? "right" : "left",
          textTransform: "uppercase",
          overflowWrap: "anywhere",
          textShadow: variant === 2 ? `${4 * scale}px ${4 * scale}px 0 ${accent}` : "none",
        }}
      >
        {focal.text}
      </div>
      {rest.map((word, index) => (
        <div
          key={`${word.start}-${index}`}
          style={{
            gridColumn: index % 2 ? "2" : "1",
            color: index === 0 ? accent : primary,
            fontFamily: variant === 3 ? '"Rajdhani", sans-serif' : '"Montserrat", sans-serif',
            fontSize: `${size * (0.42 + (index % 2) * 0.12)}px`,
            fontWeight: 800,
            lineHeight: 0.9,
            textAlign: index % 2 ? "right" : "left",
            textTransform: "uppercase",
            letterSpacing: variant === 3 ? `${2 * scale}px` : 0,
          }}
        >
          {word.text}
        </div>
      ))}
    </div>
  );
}

function renderRibbon(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  const splitAt = Math.ceil(words.length / 2);
  const bands = [words.slice(0, splitAt), words.slice(splitAt)].filter((band) => band.length);
  return (
    <div
      style={{
        width: "92%",
        maxWidth: `${960 * scale}px`,
        display: "flex",
        flexDirection: "column",
        gap: `${variant === 2 ? 14 : 5}px`,
        rotate: `${variant === 1 ? -4 : variant === 2 ? 2 : -1.5}deg`,
        transform: variant === 3 ? "skewY(-3deg)" : "none",
      }}
    >
      {bands.map((band, bandIndex) => (
        <div
          key={`ribbon-band-${bandIndex}`}
          style={{
            width: bandIndex === 1 && variant === 1 ? "82%" : "100%",
            marginLeft: bandIndex === 1 && variant === 1 ? "auto" : 0,
            boxSizing: "border-box",
            padding: `${variant === 2 ? 12 : 7 * scale}px ${16 * scale}px`,
            background:
              variant === 2 && bandIndex === 0
                ? `linear-gradient(90deg, ${accent}, transparent)`
                : variant === 3
                  ? `linear-gradient(90deg, transparent, ${accent} 18%, ${accent} 82%, transparent)`
                  : "transparent",
            borderTop: variant === 0 || variant === 1 ? `${3 * scale}px solid ${accent}` : "none",
            borderBottom: variant === 0 || variant === 1 ? `${1 * scale}px solid ${accent}99` : "none",
            color: primary,
            fontFamily: variant === 1 ? '"Rajdhani", sans-serif' : '"Outfit", sans-serif',
            fontSize: `${size * (bandIndex === 0 ? 0.9 : 1.02)}px`,
            fontWeight: 900,
            lineHeight: 0.96,
            textAlign: bandIndex % 2 ? "right" : "left",
            textTransform: "uppercase",
            textShadow: variant === 3 ? `0 ${3 * scale}px 0 rgba(0,0,0,0.55)` : "none",
            opacity: 0.78 + progress * 0.22,
          }}
        >
          {band.map((word, index) => (
            <React.Fragment key={`${word.start}-${index}`}>
              {word.text}{index < band.length - 1 ? " " : ""}
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

function renderOrbit(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  const diameter = (variant === 2 ? 430 : 390) * scale;
  const radius = diameter * (variant === 3 ? 0.38 : 0.42);
  return (
    <div
      style={{
        position: "relative",
        width: `${diameter}px`,
        height: `${diameter}px`,
        maxWidth: "88vw",
        flex: `0 0 ${diameter}px`,
        border: `${variant === 1 ? 2 : 1}px solid ${accent}99`,
        borderRadius: variant === 2 ? "44% 56% 50% 50%" : "50%",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "18%",
          border: `${Math.max(1, 2 * scale)}px solid ${accent}`,
          borderRadius: "50%",
          clipPath: `inset(0 ${Math.max(0, (1 - progress) * 100)}% 0 0)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: "31% 19%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: primary,
          fontFamily: '"Montserrat", sans-serif',
          fontSize: `${size * 0.26}px`,
          fontWeight: 700,
          letterSpacing: `${2 * scale}px`,
          textAlign: "center",
          textTransform: "uppercase",
        }}
      >
        {variant === 1 ? `${Math.round(progress * 100)}%` : variant === 3 ? "IN MOTION" : "SPEAK / MOVE"}
      </div>
      {words.map((word, index) => {
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / words.length;
        const x = 50 + (Math.cos(angle) * radius * 100) / diameter;
        const y = 50 + (Math.sin(angle) * radius * 100) / diameter;
        const rotation = variant === 2 ? (angle * 180) / Math.PI + 90 : 0;
        return (
          <span
            key={`${word.start}-${index}`}
            style={{
              position: "absolute",
              left: `${x}%`,
              top: `${y}%`,
              color: index / words.length <= progress ? accent : primary,
              fontFamily: variant === 3 ? '"Rajdhani", sans-serif' : '"Outfit", sans-serif',
              fontSize: `${size * (variant === 0 ? 0.34 : 0.3)}px`,
              fontWeight: 800,
              whiteSpace: "nowrap",
              textTransform: "uppercase",
              transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
}

function renderBracket(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
  progress: number,
) {
  const splitAt = Math.ceil(words.length / 2);
  const lines = [words.slice(0, splitAt), words.slice(splitAt)].filter((line) => line.length);
  const corner = `${28 * scale}px solid ${accent}`;
  return (
    <div
      style={{
        position: "relative",
        width: "88%",
        maxWidth: `${920 * scale}px`,
        padding: `${26 * scale}px ${30 * scale}px`,
        boxSizing: "border-box",
        borderTop: variant === 1 || variant === 3 ? `${2 * scale}px solid ${accent}` : "none",
        borderBottom: variant === 1 || variant === 3 ? `${2 * scale}px solid ${accent}` : "none",
        background: variant === 3 ? `linear-gradient(90deg, ${accent}16 1px, transparent 1px)` : "transparent",
      }}
    >
      <span style={{ position: "absolute", inset: 0, borderTop: corner, borderLeft: corner, width: `${30 * scale}px`, height: `${30 * scale}px`, borderRight: 0, borderBottom: 0 }} />
      <span style={{ position: "absolute", right: 0, bottom: 0, borderRight: corner, borderBottom: corner, width: `${30 * scale}px`, height: `${30 * scale}px`, borderLeft: 0, borderTop: 0 }} />
      {variant === 2 && (
        <div style={{ position: "absolute", left: 0, top: `${progress * 100}%`, width: `${5 * scale}px`, height: `${48 * scale}px`, background: accent }} />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: `${8 * scale}px`, color: primary, fontFamily: '"Outfit", sans-serif', fontSize: `${size * 0.88}px`, fontWeight: 800, lineHeight: 1.03, textAlign: variant === 3 ? "center" : "left", textTransform: "uppercase" }}>
        {lines.map((line, index) => (
          <div key={`bracket-line-${index}`}>
            {line.map((word, wordIndex) => (
              <React.Fragment key={`${word.start}-${wordIndex}`}>
                {word.text}{wordIndex < line.length - 1 ? " " : ""}
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderStencil(
  words: WordTiming[],
  primary: string,
  accent: string,
  size: number,
  variant: number,
  scale: number,
) {
  const splitAt = Math.ceil(words.length / 2);
  const lines = [words.slice(0, splitAt), words.slice(splitAt)].filter((line) => line.length);
  return (
    <div style={{ width: "92%", maxWidth: `${950 * scale}px`, display: "flex", flexDirection: "column", gap: `${variant === 2 ? 12 : 4 * scale}px`, alignItems: variant === 1 ? "flex-start" : "center", textAlign: variant === 1 ? "left" : "center" }}>
      {lines.map((line, lineIndex) => (
        <div
          key={`stencil-line-${lineIndex}`}
          style={{
            fontFamily: variant === 2 ? '"Rajdhani", sans-serif' : '"Montserrat", sans-serif',
            fontSize: `${size * (lineIndex === 0 ? 0.95 : 0.78)}px`,
            fontWeight: 900,
            lineHeight: 0.94,
            textTransform: "uppercase",
            WebkitTextStroke: variant === 1 ? `${1.2 * scale}px ${primary}` : undefined,
            color: variant === 1 ? "transparent" : lineIndex === variant % lines.length ? accent : primary,
            background: variant === 3 && lineIndex === 0 ? `linear-gradient(transparent 56%, ${accent} 56%)` : undefined,
            backgroundClip: variant === 3 && lineIndex === 0 ? "text" : undefined,
            WebkitBackgroundClip: variant === 3 && lineIndex === 0 ? "text" : undefined,
            textShadow: variant === 0 ? `${4 * scale}px ${4 * scale}px 0 rgba(0,0,0,0.35)` : "none",
            letterSpacing: variant === 2 ? `${1.2 * scale}px` : 0,
          }}
        >
          {line.map((word, index) => (
            <React.Fragment key={`${word.start}-${index}`}>
              {word.text}{index < line.length - 1 ? " " : ""}
            </React.Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}

export function createAdditionalTheme(id: string): React.FC<InternalThemeProps> {
  const spec = SPECS.find((item) => item.id === id);
  if (!spec) throw new Error(`Unknown additional caption theme: ${id}`);

  const Theme: React.FC<InternalThemeProps> = ({
    primaryColor,
    secondaryColor,
    data,
    fontSize,
  }) => {
    const frame = useCurrentFrame();
    const { fps, width } = useVideoConfig();
    const words = wordsFrom(data);
    if (words.length === 0) return null;

    const scale = width / 1080;
    const time = frame / fps;
    const size = (typeof fontSize === "number" ? fontSize : 64) * scale;
    const progress = progressFor(words, time);
    const entrance = spring({
      frame: frame - Math.round(words[0].start * fps),
      fps,
      config: { damping: 18, stiffness: 150, mass: 0.7 },
    });
    let content: React.ReactNode;

    if (spec.family === "poster") {
      content = renderPoster(
        words,
        primaryColor,
        secondaryColor,
        size,
        spec.variant,
        scale,
      );
    } else if (spec.family === "stair") {
      content = renderStair(
        words,
        primaryColor,
        secondaryColor,
        size,
        spec.variant,
        scale,
        frame,
        fps,
      );
    } else if (spec.family === "arc") {
      content = renderArc(
        words,
        primaryColor,
        secondaryColor,
        size,
        spec.variant,
        scale,
        progress,
      );
    } else if (spec.family === "columns") {
      content = renderColumns(
        words,
        primaryColor,
        secondaryColor,
        size,
        spec.variant,
        scale,
        progress,
      );
    } else if (spec.family === "ledger") {
      content = renderLedger(
        words,
        primaryColor,
        secondaryColor,
        size,
        spec.variant,
        scale,
        progress,
      );
    } else if (spec.family === "mosaic") {
      content = renderMosaic(words, primaryColor, secondaryColor, size, spec.variant, scale);
    } else if (spec.family === "ribbon") {
      content = renderRibbon(words, primaryColor, secondaryColor, size, spec.variant, scale, progress);
    } else if (spec.family === "orbit") {
      content = renderOrbit(words, primaryColor, secondaryColor, size, spec.variant, scale, progress);
    } else if (spec.family === "bracket") {
      content = renderBracket(words, primaryColor, secondaryColor, size, spec.variant, scale, progress);
    } else {
      content = renderStencil(words, primaryColor, secondaryColor, size, spec.variant, scale);
    }

    return (
      <div
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "center",
          opacity: entrance,
          translate: `0px ${(1 - entrance) * 12 * scale}px`,
        }}
      >
        {content}
      </div>
    );
  };

  Theme.displayName = `${id}CaptionTheme`;
  return Theme;
}

export const ADDITIONAL_THEME_COMPONENTS = Object.fromEntries(
  SPECS.map(({ id }) => [id, createAdditionalTheme(id)]),
) as Record<string, React.FC<InternalThemeProps>>;

export const ADDITIONAL_THEME_IDS = SPECS.map(({ id }) => id);