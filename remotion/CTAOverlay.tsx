import React from 'react';

interface CTAOverlayProps {
  ctaText: string;
  ctaDurationInSeconds: number;
  currentTime: number;
  totalDurationInSeconds: number;
}

export const CTAOverlay: React.FC<CTAOverlayProps> = ({
  ctaText,
  ctaDurationInSeconds,
  currentTime,
  totalDurationInSeconds,
}) => {
  if (!ctaText || ctaDurationInSeconds <= 0) {
    return null;
  }

  const startTime = Math.max(0, totalDurationInSeconds - ctaDurationInSeconds);
  if (currentTime < startTime || currentTime > totalDurationInSeconds) {
    return null;
  }

  const localTime = currentTime - startTime;
  const fadeIn = Math.min(1, localTime / 0.25);
  const fadeOut = Math.min(1, Math.max(0, (totalDurationInSeconds - currentTime) / 0.3));
  const opacity = fadeIn * fadeOut;
  const scale = 0.94 + opacity * 0.06;

  return (
    <div
      style={{
        position: 'absolute',
        left: '7%',
        right: '7%',
        bottom: '12%',
        zIndex: 35,
        opacity,
        transform: `scale(${scale})`,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '880px',
          borderRadius: '24px',
          padding: '18px 22px',
          background:
            'linear-gradient(135deg, rgba(34,197,94,0.94), rgba(14,165,233,0.94))',
          boxShadow: '0 18px 50px rgba(0, 0, 0, 0.45)',
          border: '2px solid rgba(255,255,255,0.2)',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            fontSize: '15px',
            letterSpacing: '2.4px',
            fontWeight: 800,
            color: 'rgba(255,255,255,0.92)',
            marginBottom: '8px',
          }}
        >
          CALL TO ACTION
        </div>
        <div
          style={{
            fontFamily: 'Inter, system-ui, sans-serif',
            fontSize: '34px',
            lineHeight: 1.2,
            fontWeight: 900,
            color: '#FFFFFF',
            textTransform: 'uppercase',
            textShadow: '0 3px 12px rgba(0, 0, 0, 0.35)',
          }}
        >
          {ctaText}
        </div>
      </div>
    </div>
  );
};
