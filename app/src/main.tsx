import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { applyHighContrastTokens } from "./lib/colorContrast";
import { applyThemeAccent } from "./lib/themeAccent";
import {
  initializeAppTheme,
  readHighContrast,
  readThemeAccent,
  resolveThemePreference,
} from "./lib/themePreference";
import "./styles/theme.css";

const initialThemePreference = initializeAppTheme();
applyThemeAccent(
  readThemeAccent(),
  resolveThemePreference(initialThemePreference),
);
applyHighContrastTokens(
  readHighContrast(),
  resolveThemePreference(initialThemePreference),
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
