const testTheme = {
  colorScheme: "light",
  colors: {
    foreground: "#111111",
    foregroundMuted: "#666666",
    foregroundExtraMuted: "#9ca3af",
    statusSuccess: "#15803d",
    statusDanger: "#b91c1c",
    statusWarning: "#d97706",
    statusMerged: "#7c3aed",
    surface1: "#fafafa",
    surface2: "#f4f4f5",
    surface3: "#e4e4e7",
    border: "#e4e4e7",
    accent: "#2563eb",
    accentMuted: "#93c5fd",
    destructive: "#b91c1c",
    diffAddition: "#15803d",
    diffDeletion: "#b91c1c",
    syntax: {
      keyword: "#cf222e",
      comment: "#6e7781",
      string: "#0a3069",
      number: "#0550ae",
      literal: "#0550ae",
      function: "#8250df",
      definition: "#8250df",
      class: "#953800",
      type: "#cf222e",
      tag: "#116329",
      attribute: "#0550ae",
      property: "#0550ae",
      variable: "#24292f",
      operator: "#0550ae",
      punctuation: "#24292f",
      regexp: "#0a3069",
      escape: "#0550ae",
      meta: "#6e7781",
      heading: "#0550ae",
      link: "#0a3069",
    },
  },
  spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32],
  fontFamily: {
    ui: "system-ui",
    mono: "monospace",
  },
  fontSize: {
    xs: 12,
    code: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    "2xl": 22,
    "3xl": 26,
  },
  fontWeight: {
    normal: "400",
    medium: "500",
    semibold: "600",
    bold: "bold",
  },
  borderRadius: {
    none: 0,
    sm: 2,
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    "2xl": 16,
    full: 9999,
  },
  borderWidth: {
    0: 0,
    1: 1,
    2: 2,
  },
  shadow: {
    sm: {
      shadowColor: "rgba(0, 0, 0, 0.02)",
      shadowOffset: { width: 0, height: 2 },
      shadowRadius: 8,
      elevation: 2,
    },
    md: {
      shadowColor: "rgba(0, 0, 0, 0.04)",
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 16,
      elevation: 4,
    },
    lg: {
      shadowColor: "rgba(0, 0, 0, 0.08)",
      shadowOffset: { width: 0, height: 8 },
      shadowRadius: 24,
      elevation: 8,
    },
  },
};

type StyleFactory<T> = (theme: typeof testTheme) => T;

function isStyleFactory<T>(styles: T | StyleFactory<T>): styles is StyleFactory<T> {
  return typeof styles === "function";
}

export const StyleSheet = {
  create: <T>(styles: T | StyleFactory<T>): T =>
    isStyleFactory(styles) ? styles(testTheme) : styles,
};

export const withUnistyles = <T>(Component: T): T => Component;

export const useUnistyles = () => ({
  theme: testTheme,
  rt: {},
  breakpoint: undefined,
});

export const UnistylesRuntime = {
  setTheme: () => undefined,
  themeName: "light",
};
