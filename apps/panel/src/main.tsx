import { lazy, StrictMode, Suspense, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { initAppearance } from "./app/appearance";
import { loadConfig } from "./app/connection";
import { LandingFallback, LandingFirst } from "./app/LandingFirst";
import { cleanHashAddress } from "./app/session";
import { landingFirst, type Visitor } from "./app/visitor";
import "./index.css";

// The panel (its shell, router and every page) loads only for someone who needs it: a first
// visit to the front page gets the landing without it.
const App = lazy(() => import("./app/App").then((m) => ({ default: m.App })));

function Boot() {
  const [front, setFront] = useState(() => landingFirst(window.location.pathname, loadConfig().token));
  const [visitor, setVisitor] = useState<Visitor | undefined>(undefined);
  const handOff = useCallback((found: Visitor) => {
    setVisitor(found);
    setFront(false);
  }, []);
  if (front) return <LandingFirst onHandOff={handOff} />;
  return (
    <Suspense fallback={<LandingFallback />}>
      <App initial={visitor} />
    </Suspense>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

initAppearance();
// Links from before clean addresses (QR codes on cards people already have) still land.
cleanHashAddress();

const start = () =>
  createRoot(root).render(
    <StrictMode>
      <Boot />
    </StrictMode>,
  );

// The karaoke page without a Core or a microphone (`/karaoke?karaoke-demo`), on the dev server
// only: a production build drops this branch and the demo with it.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("karaoke-demo")) {
  void import("./pages/public/karaoke/demo").then((m) => m.installDemo()).finally(start);
} else {
  start();
}
