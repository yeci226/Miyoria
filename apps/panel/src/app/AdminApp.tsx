import { type RouterHistory, RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { EventStreamProvider } from "./events-store";
import { type AppRouter, createAppRouter } from "./router";

/**
 * The admin panel: its router, shell, navigation and event stream. `App` loads it on demand, so
 * the public site and the sign-in screen never download it.
 */
export default function AdminApp({ router, history }: { router?: AppRouter; history: RouterHistory }) {
  const [r] = useState(() => router ?? createAppRouter(history));
  return (
    <EventStreamProvider>
      <RouterProvider router={r} />
    </EventStreamProvider>
  );
}
