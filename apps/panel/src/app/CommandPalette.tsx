import { useNavigate } from "@tanstack/react-router";
import { Boxes, CornerDownLeft, UserRound } from "lucide-react";
import { useDeferredValue, useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { NAV } from "./nav";
import { useModules, usePeople } from "./queries";

/** ⌘K: pages and their tabs, people (searched on the Core), modules. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const needle = useDeferredValue(q.trim());
  const people = usePeople({ q: needle || undefined, limit: 8 }, open);
  const modules = useModules();

  const go = (fn: () => void) => {
    onOpenChange(false);
    setQ("");
    fn();
  };

  const lower = needle.toLowerCase();
  const moduleHits = (modules.data ?? [])
    .filter((m) => !lower || m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower))
    .slice(0, 8);

  return (
    <CommandDialog
      title="搜尋與跳轉"
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQ("");
      }}
    >
      <CommandInput placeholder="頁面、人、子系統…" value={q} onValueChange={setQ} />
      <CommandList>
        <CommandEmpty>沒有符合的項目</CommandEmpty>
        <CommandGroup heading="頁面">
          {NAV.flatMap((item) => [
            <CommandItem
              key={item.to}
              value={`page ${item.label} ${item.to}`}
              onSelect={() => go(() => void navigate({ to: item.to }))}
            >
              <item.icon />
              {item.label}
            </CommandItem>,
            ...(item.tabs ?? []).map((t) => (
              <CommandItem
                key={`${item.to}-${t.tab}`}
                value={`page ${item.label} ${t.label} ${t.tab}`}
                onSelect={() => go(() => void navigate({ to: item.to, search: { tab: t.tab } as never }))}
              >
                <item.icon />
                <span className="text-muted-foreground">{item.label} /</span>
                {t.label}
              </CommandItem>
            )),
          ])}
        </CommandGroup>
        {(people.data?.items.length ?? 0) > 0 && (
          <CommandGroup heading="人">
            {people.data?.items.map((p) => (
              <CommandItem
                key={p.person.id}
                value={`person ${p.person.display_name} ${p.person.accounts.map((a) => `${a.display_name} ${a.account.id}`).join(" ")} ${p.person.id}`}
                onSelect={() =>
                  go(() => void navigate({ to: "/character", search: { tab: "people", person: p.person.id } }))
                }
              >
                <UserRound />
                {p.person.display_name}
                <span className="text-muted-foreground">{p.tier_label || p.tier}</span>
                <CommandShortcut>
                  <CornerDownLeft className="size-3" />
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {moduleHits.length > 0 && (
          <CommandGroup heading="子系統">
            {moduleHits.map((m) => (
              <CommandItem
                key={m.id}
                value={`module ${m.name} ${m.id}`}
                onSelect={() => go(() => void navigate({ to: "/system", search: { tab: "modules", q: m.id } }))}
              >
                <Boxes />
                {m.name}
                <span className="font-mono text-xs text-muted-foreground">{m.id}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
