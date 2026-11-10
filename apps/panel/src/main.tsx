import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initAppearance } from "./app/appearance";
import { cleanHashAddress } from "./app/session";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

initAppearance();
// Links from before clean addresses (QR codes on cards people already have) still land.
cleanHashAddress();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
