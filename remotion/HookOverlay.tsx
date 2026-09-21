import React from 'react';

interface HookOverlayProps {
  hookText: string;
  durationInSeconds: number;
  currentTime: number; // in seconds
}

export const HookOverlay: React.FC<HookOverlayProps> = ({
  hookText,
  durationInSeconds,
  currentTime,
}) => {
  if (currentTime > durationInSeconds || !hookText) {
    return null;
  }

  // Animation progress
  const fadeIn = Math.min(1, currentTime / 0.3);
  const fadeOut = Math.min(1, Math.max(0, (durationInSeconds - currentTime) / 0.3));
  const opacity = fadeIn * fadeOut;

  return (
    <div
      style={{
        position: 'absolute',
        top: '18%',
        left: '6%',
        right: '6%',
        zIndex: 30,
        opacity,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 0.2s ease-in-out',
      }}
    >
      <div
        style={{
          backgroundColor: 'rgba(239, 68, 68, 0.95)', // vibrant red hook badge
          color: '#FFFFFF',
          fontSize: '14px',
          fontWeight: 800,
          textTransform: 'uppercase',
          letterSpacing: '2px',
          padding: '4px 14px',
          borderRadius: '20px',
          marginBottom: '8px',
          boxShadow: '0 4px 12px rgba(239, 68, 68, 0.5)',
        }}
      >
        HOOK INTRO
      </div>

      <div
        style={{
          background: 'linear-gradient(135deg, rgba(0, 0, 0, 0.88), rgba(15, 23, 42, 0.92))',
          border: '2px solid rgba(255, 230, 0, 0.9)',
          borderRadius: '16px',
          padding: '20px 24px',
          textAlign: 'center',
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.7), 0 0 20px rgba(255, 230, 0, 0.3)',
        }}
      >
        <span
          style={{
            fontFamily: 'Inter, Impact, sans-serif',
            fontSize: '38px',
            fontWeight: 900,
            color: '#FFE600',
            lineHeight: 1.2,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            textShadow: '2px 2px 8px rgba(0, 0, 0, 0.9)',
            display: 'block',
          }}
        >
          {hookText}
        </span>
      </div>
    </div>
  );
};
