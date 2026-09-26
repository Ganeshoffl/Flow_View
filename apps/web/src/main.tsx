import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@flow-view/renderers/styles.css";

import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) throw new Error("no #root element to mount into");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
