import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AdminSpaces } from "@miyoria/contracts/api";
import { ConnectionProvider } from "@/app/connection";
import { mockFetch, testQueryClient } from "@/test/render";
import { useAdminSpace } from "./space";

const SPACES: AdminSpaces = {
  spaces: [
    { id: "a", platform: "discord", external_id: "1", name: "A", primary: true, established: true, members: 3 },
    { id: "b", platform: "discord", external_id: "2", name: "B", primary: false, established: false, members: 1 },
  ],
  default: "a",
};

function Probe() {
  const { space, multiple, setSpace } = useAdminSpace();
  return (
    <div>
      <output aria-label="now">{space ?? "none"}</output>
      <output aria-label="multiple">{String(multiple)}</output>
      <button type="button" onClick={() => setSpace("b")}>
        B
      </button>
      <button type="button" onClick={() => setSpace("a")}>
        A
      </button>
    </div>
  );
}

function renderAt(path: string) {
  const root = createRootRoute();
  const route = createRoute({ getParentRoute: () => root, path: "/economy", component: Probe });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree: root.addChildren([route]), history });
  render(
    <ConnectionProvider initial={{ baseUrl: "", token: "t0ken" }}>
      <QueryClientProvider client={testQueryClient()}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </ConnectionProvider>,
  );
  return history;
}

const answer = (body: AdminSpaces) =>
  mockFetch((_m, url) => (url.pathname === "/api/places/spaces" ? { body } : undefined));

describe("useAdminSpace", () => {
  it("is the primary without ?space=, and the address's server with it; the default leaves the address", async () => {
    const user = userEvent.setup();
    answer(SPACES);
    const history = renderAt("/economy?tab=market");
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("a"));
    expect(screen.getByLabelText("multiple")).toHaveTextContent("true");
    await user.click(screen.getByRole("button", { name: "B" }));
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("b"));
    expect(history.location.search).toContain("space=b");
    expect(history.location.search).toContain("tab=market");
    await user.click(screen.getByRole("button", { name: "A" }));
    await waitFor(() => expect(history.location.search).not.toContain("space="));
  });

  it("a server it does not know falls back to the default", async () => {
    answer(SPACES);
    renderAt("/economy?space=gone");
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("a"));
  });

  it("an older Core without the route: no server, nothing to switch", async () => {
    mockFetch(() => undefined);
    renderAt("/economy");
    await waitFor(() => expect(screen.getByLabelText("multiple")).toHaveTextContent("false"));
    expect(screen.getByLabelText("now")).toHaveTextContent("none");
  });
});
