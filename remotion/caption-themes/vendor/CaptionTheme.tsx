import React from "react";
import { CaptionThemeProps } from "./types";
import { resolveColors } from "./utils/resolveColors";
import { themeRegistry } from "./registry";

export const CaptionTheme: React.FC<CaptionThemeProps> = ({
  primaryColor,
  secondaryColor,
  data,
  theme = "kinetic-01",
  fontSize,
}) => {
  const colors = resolveColors(primaryColor, secondaryColor);
  const ThemeComponent = themeRegistry[theme] || themeRegistry["kinetic-01"];

  return (
    <ThemeComponent
      primaryColor={colors.primary}
      secondaryColor={colors.secondary}
      data={data}
      fontSize={fontSize}
    />
  );
};
