import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { MemberSpaces, Space } from "@miyoria/contracts/api";
import { mockFetch, renderPage } from "@/test/render";
import { SpacePicker, useMemberSpace } from "./member-space";

const space = (id: string, name: string, primary = false): Space => ({
  id,
  platform: "discord",
  external_id: `g-${id}`,
  name,
  primary,
  established: primary,
});

function Probe() {
  const { space: current, spaces, setSpace } = useMemberSpace();
  return (
    <div>
      <SpacePicker value={current} spaces={spaces} onChange={setSpace} />
      <output aria-label="now">{current ?? "none"}</output>
    </div>
  );
}

const answer = (body: MemberSpaces) =>
  mockFetch((_m, url) => (url.pathname === "/api/member/spaces" ? { body } : undefined));

afterEach(() => window.localStorage.clear());

describe("SpacePicker", () => {
  it("draws nothing for one server or none", () => {
    const { container, rerender } = render(<SpacePicker value="a" spaces={[space("a", "A", true)]} onChange={() => {}} />);
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
    rerender(<SpacePicker value={null} spaces={[]} onChange={() => {}} />);
    expect(container.querySelector("[role='radiogroup']")).toBeNull();
  });

  it("shows up to four servers side by side, more in a select", () => {
    const four = ["A", "B", "C", "D"].map((n, i) => space(n, `伺服器 ${n}`, i === 0));
    const { rerender } = render(<SpacePicker value="A" spaces={four} onChange={() => {}} />);
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: "伺服器 A" })).toHaveAttribute("aria-checked", "true");
    rerender(<SpacePicker value="A" spaces={[...four, space("E", "伺服器 E")]} onChange={() => {}} />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByRole("combobox", { name: "伺服器" })).toBeInTheDocument();
  });
});

describe("useMemberSpace", () => {
  it("takes the Core's default, and remembers what they pick", async () => {
    const user = userEvent.setup();
    answer({ spaces: [space("a", "A", true), space("b", "B")], default: "a" });
    const first = renderPage(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("a"));
    await user.click(screen.getByRole("radio", { name: "B" }));
    expect(screen.getByLabelText("now")).toHaveTextContent("b");
    first.unmount();
    renderPage(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("b"));
  });

  it("a single server: no picker, its id; a server they left falls back to the default", async () => {
    window.localStorage.setItem("miyoria.member.space", "gone");
    answer({ spaces: [space("a", "A", true)], default: "a" });
    renderPage(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("a"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("an older Core without the route: nothing chosen, nothing drawn", async () => {
    mockFetch(() => undefined);
    renderPage(<Probe />);
    await waitFor(() => expect(screen.getByLabelText("now")).toHaveTextContent("none"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
