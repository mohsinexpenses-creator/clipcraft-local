import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { InternalThemeProps, WordTiming } from "../types";

function getWords(data: InternalThemeProps["data"]): WordTiming[] {
  return data.lines[0]?.words ?? [];
}

function getSpeechProgress(words: WordTiming[], time: number): number {
  const activeIndex = words.findIndex(
    (word) => time >= word.start && time <= word.end,
  );
  if (activeIndex < 0) return time < (words[0]?.start ?? 0) ? 0 : 1;

  const active = words[activeIndex];
  const withinWord = interpolate(
    time,
    [active.start, Math.max(active.start + 0.04, active.end)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (activeIndex + withinWord) / words.length;
}

export const PullQuoteTheme: React.FC<InternalThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = getWords(data);
  if (words.length === 0) return null;

  const scale = width / 1080;
  const size = (typeof fontSize === "number" ? fontSize : 68) * scale;
  const entrance = spring({
    frame: frame - Math.round(words[0].start * fps),
    fps,
    config: { damping: 18, stiffness: 130, mass: 0.75 },
  });
  const splitAt = Math.ceil(words.length / 2);
  const quoteLines = [words.slice(0, splitAt), words.slice(splitAt)].filter(
    (line) => line.length > 0,
  );

  return (
    <div
      style={{
        position: "relative",
        width: "84%",
        maxWidth: `${900 * scale}px`,
        padding: `${20 * scale}px 0 ${16 * scale}px ${36 * scale}px`,
        boxSizing: "border-box",
        borderLeft: `${3 * scale}px solid ${secondaryColor}`,
        textAlign: "left",
        transform: `translateY(${(1 - entrance) * 16 * scale}px)`,
        opacity: entrance,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: `${-36 * scale}px`,
          left: `${24 * scale}px`,
          color: secondaryColor,
          fontFamily: '"Outfit", sans-serif',
          fontSize: `${size * 2.1}px`,
          fontWeight: 800,
          lineHeight: 1,
        }}
      >
        “
      </div>
      <div
        style={{
          color: primaryColor,
          fontFamily: '"Outfit", sans-serif',
          fontSize: `${size * 1.22}px`,
          fontWeight: 700,
          lineHeight: 1.02,
          textWrap: "balance",
        }}
      >
          {quoteLines.map((line, lineIndex) => (
            <div key={`quote-line-${lineIndex}`}>
              {line.map((word, index) => {
                return (
                  <React.Fragment key={`${word.start}-${index}`}>
                    <span
                      style={{
                        display: "inline-block",
                      }}
                    >
                      {word.text}
                    </span>
                    {index < line.length - 1 ? " " : ""}
                  </React.Fragment>
                );
              })}
            </div>
          ))}
      </div>
      <div
        style={{
          marginTop: `${14 * scale}px`,
          width: `${42 * scale}px`,
          height: `${3 * scale}px`,
          background: secondaryColor,
        }}
      />
    </div>
  );
};

export const WaveformTheme: React.FC<InternalThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = getWords(data);
  if (words.length === 0) return null;

  const scale = width / 1080;
  const time = frame / fps;
  const size = (typeof fontSize === "number" ? fontSize : 64) * scale;
  const progress = getSpeechProgress(words, time);
  const activeWord = words.find(
    (word) => time >= word.start && time <= word.end,
  );
  const energy = activeWord
    ? interpolate(
        time,
        [activeWord.start, (activeWord.start + activeWord.end) / 2, activeWord.end],
        [0.25, 1, 0.35],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
      )
    : 0.2;
  const splitAt = Math.ceil(words.length / 2);
  const phraseLines = [words.slice(0, splitAt), words.slice(splitAt)].filter(
    (line) => line.length > 0,
  );

  return (
    <div
      style={{
        width: "88%",
        maxWidth: `${940 * scale}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: `${22 * scale}px`,
      }}
    >
      <div
        style={{
          width: "90%",
          color: primaryColor,
          fontFamily: '"Montserrat", sans-serif',
          fontSize: `${size * 1.16}px`,
          fontWeight: 800,
          lineHeight: 0.98,
          textAlign: "center",
        }}
      >
        {phraseLines.map((line, lineIndex) => (
          <div key={`wave-phrase-${lineIndex}`}>
            {line.map((word, index) => {
              return (
                <React.Fragment key={`${word.start}-${index}`}>
                  <span>{word.text}</span>
                  {index < line.length - 1 ? " " : ""}
                </React.Fragment>
              );
            })}
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        style={{
          width: "90%",
          height: `${84 * scale}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: `${4 * scale}px`,
        }}
      >
        {Array.from({ length: 43 }, (_, index) => {
          const position = index / 42;
          const shape = 0.22 + Math.abs(Math.sin(index * 1.73)) * 0.78;
          const pulse = 0.65 + Math.sin(time * 11 + index * 0.46) * 0.35;
          const height = (12 + shape * 58 * energy * pulse) * scale;
          const isPlayed = position <= progress;
          return (
            <span
              key={index}
              style={{
                flex: 1,
                height: `${height}px`,
                borderRadius: `${2 * scale}px`,
                backgroundColor: isPlayed ? secondaryColor : primaryColor,
                opacity: isPlayed ? 0.95 : 0.32,
              }}
            />
          );
        })}
      </div>
    </div>
  );
};

export const StaggeredStackTheme: React.FC<InternalThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = getWords(data);
  if (words.length === 0) return null;

  const scale = width / 1080;
  const size = (typeof fontSize === "number" ? fontSize : 66) * scale;
  const anchorIndex = words.reduce((best, word, index) => {
    const length = word.text.replace(/[^\p{L}\p{N}]/gu, "").length;
    const bestLength = words[best].text.replace(/[^\p{L}\p{N}]/gu, "").length;
    return length > bestLength ? index : best;
  }, 0);
  const supportingWords = words.filter((_, index) => index !== anchorIndex);
  const supportingBefore = supportingWords.slice(
    0,
    Math.ceil(supportingWords.length / 2),
  );
  const supportingAfter = supportingWords.slice(supportingBefore.length);
  const anchor = words[anchorIndex];
  const anchorEntrance = spring({
    frame: frame - Math.round(words[0].start * fps),
    fps,
    config: { damping: 13, stiffness: 145, mass: 0.7 },
  });

  const supportingLine = (items: WordTiming[]) =>
    items.map((word, index) => (
      <React.Fragment key={`${word.start}-${index}`}>
        <span>{word.text}</span>
        {index < items.length - 1 ? " " : ""}
      </React.Fragment>
    ));

  return (
    <div
      style={{
        width: "90%",
        maxWidth: `${940 * scale}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: `${8 * scale}px`,
        textAlign: "right",
        opacity: anchorEntrance,
        transform: `translateY(${(1 - anchorEntrance) * 18 * scale}px)`,
      }}
    >
      {supportingBefore.length > 0 && (
        <div
          style={{
            color: secondaryColor,
            fontFamily: '"Montserrat", sans-serif',
            fontSize: `${size * 0.32}px`,
            fontWeight: 700,
            letterSpacing: `${size * 0.08}px`,
            lineHeight: 1.15,
            textTransform: "uppercase",
          }}
        >
          {supportingLine(supportingBefore)}
        </div>
      )}
      <div
        style={{
          color: primaryColor,
          fontFamily: '"Outfit", sans-serif',
          fontSize: `${size * 1.52}px`,
          fontWeight: 900,
          lineHeight: 0.88,
          whiteSpace: "nowrap",
          textTransform: "uppercase",
          transform: `scale(${0.92 + anchorEntrance * 0.08})`,
          textShadow: `${4 * scale}px ${4 * scale}px 0 ${secondaryColor}`,
        }}
      >
        {anchor.text}
      </div>
      {supportingAfter.length > 0 && (
        <div
          style={{
            color: secondaryColor,
            fontFamily: '"Montserrat", sans-serif',
            fontSize: `${size * 0.32}px`,
            fontWeight: 700,
            letterSpacing: `${size * 0.08}px`,
            lineHeight: 1.15,
            textTransform: "uppercase",
          }}
        >
          {supportingLine(supportingAfter)}
        </div>
      )}
    </div>
  );
};

export const FocusDialTheme: React.FC<InternalThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = getWords(data);
  if (words.length === 0) return null;

  const scale = width / 1080;
  const time = frame / fps;
  const progress = getSpeechProgress(words, time);
  const size = (typeof fontSize === "number" ? fontSize : 64) * scale;
  const entrance = spring({
    frame: frame - Math.round(words[0].start * fps),
    fps,
    config: { damping: 18, stiffness: 140, mass: 0.7 },
  });
  const splitAt = Math.ceil(words.length / 2);
  const phraseLines = [words.slice(0, splitAt), words.slice(splitAt)].filter(
    (line) => line.length > 0,
  );

  return (
    <div
      style={{
        position: "relative",
        width: `${600 * scale}px`,
        height: `${600 * scale}px`,
        maxWidth: "90%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: entrance,
        scale: `${0.92 + entrance * 0.08}`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: `conic-gradient(${secondaryColor} ${progress * 100}%, rgba(255,255,255,0.2) 0)`,
          mask: `radial-gradient(farthest-side, transparent calc(100% - ${5 * scale}px), #000 calc(100% - ${4 * scale}px))`,
          WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${5 * scale}px), #000 calc(100% - ${4 * scale}px))`,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: `${20 * scale}px`,
          border: `${1 * scale}px solid rgba(255,255,255,0.22)`,
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          width: "74%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: `${8 * scale}px`,
          color: primaryColor,
          fontFamily: '"Montserrat", sans-serif',
          fontSize: `${size * 0.96}px`,
          fontWeight: 800,
          lineHeight: 1.02,
          textAlign: "center",
          textTransform: "uppercase",
          textWrap: "balance",
        }}
      >
        {phraseLines.map((line, lineIndex) => (
          <div key={`dial-line-${lineIndex}`}>
            {line.map((word, wordIndex) => (
              <React.Fragment key={`${word.start}-${wordIndex}`}>
                {word.text}
                {wordIndex < line.length - 1 ? " " : ""}
              </React.Fragment>
            ))}
          </div>
        ))}
        <div
          style={{
            marginTop: `${4 * scale}px`,
            color: secondaryColor,
            fontFamily: '"Rajdhani", sans-serif',
            fontSize: `${size * 0.24}px`,
            fontWeight: 700,
            letterSpacing: `${size * 0.1}px`,
            lineHeight: 1,
          }}
        >
          VOICE / {String(Math.round(progress * 100)).padStart(2, "0")}
        </div>
      </div>
    </div>
  );
};

export const VerticalTickerTheme: React.FC<InternalThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  fontSize,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const words = getWords(data);
  if (words.length === 0) return null;

  const scale = width / 1080;
  const time = frame / fps;
  const progress = getSpeechProgress(words, time);
  const size = (typeof fontSize === "number" ? fontSize : 64) * scale;
  const entrance = spring({
    frame: frame - Math.round(words[0].start * fps),
    fps,
    config: { damping: 17, stiffness: 150, mass: 0.7 },
  });

  return (
    <div
      style={{
        width: "86%",
        maxWidth: `${880 * scale}px`,
        display: "flex",
        alignItems: "stretch",
        gap: `${22 * scale}px`,
        opacity: entrance,
        translate: `${(1 - entrance) * -20 * scale}px 0px`,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "relative",
          width: `${4 * scale}px`,
          flex: `0 0 ${4 * scale}px`,
          background: "rgba(255,255,255,0.25)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: secondaryColor,
            transformOrigin: "top",
            scale: `1 ${progress}`,
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: `${5 * scale}px`,
        }}
      >
        {words.map((word, index) => {
          const side = index % 2 === 0 ? "left" : "right";
          return (
            <div
              key={`${word.start}-${index}`}
              style={{
                width: "100%",
                boxSizing: "border-box",
                paddingLeft: side === "left" ? `${18 * scale}px` : `${36 * scale}px`,
                paddingRight: side === "right" ? `${18 * scale}px` : `${36 * scale}px`,
                color: primaryColor,
                fontFamily: '"Rajdhani", sans-serif',
                fontSize: `${size * (index === words.length - 1 ? 0.92 : 0.72)}px`,
                fontWeight: index === words.length - 1 ? 700 : 600,
                lineHeight: 0.94,
                textAlign: side,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              {word.text}
            </div>
          );
        })}
      </div>
    </div>
  );
};