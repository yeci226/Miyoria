import { Check, ChevronsUpDown, Hash } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import type { AuthScope } from "@miyoria/contracts/api";
import type { AccountRef } from "@miyoria/contracts/wire";
import { useAccessMutations, usePeople } from "@/app/queries";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** Platforms accounts and guild scopes can belong to. */
export const PLATFORMS = ["discord"] as const;

interface Picked {
  account: AccountRef;
  /** Display name, when picked from a person. */
  name: string | null;
}

/** Combobox over the people the Core knows, filtered to accounts on `platform`; a raw id works too. */
function PersonPicker({
  id,
  platform,
  value,
  onChange,
}: {
  id: string;
  platform: string;
  value: Picked | null;
  onChange: (v: Picked | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const needle = useDeferredValue(q.trim());
  const people = usePeople({ q: needle || undefined, limit: 20 }, open);
  const options = (people.data?.items ?? []).flatMap((p) =>
    p.person.accounts
      .filter((a) => a.account.platform === platform)
      .map((a) => ({ person: p.person.display_name, display: a.display_name, account: a.account })),
  );
  const raw = /^\d{5,}$/.test(needle) && !options.some((o) => o.account.id === needle) ? needle : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              {value.name && <span className="truncate">{value.name}</span>}
              <span className="truncate font-mono text-xs text-muted-foreground">{value.account.id}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">選擇人或輸入帳號 id</span>
          )}
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">
        <Command shouldFilter={false}>
          <CommandInput placeholder="名稱或帳號 id" value={q} onValueChange={setQ} />
          <CommandList>
            {!raw && <CommandEmpty>{people.isFetching ? "搜尋中…" : "沒有符合的人"}</CommandEmpty>}
            {raw && (
              <CommandGroup>
                <CommandItem
                  value={`raw-${raw}`}
                  onSelect={() => {
                    onChange({ account: { platform, id: raw }, name: null });
                    setOpen(false);
                  }}
                >
                  <Hash />
                  使用帳號 id <span className="font-mono">{raw}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {options.length > 0 && (
              <CommandGroup>
                {options.map((o) => {
                  const selected = value?.account.id === o.account.id;
                  return (
                    <CommandItem
                      key={`${o.account.platform}:${o.account.id}`}
                      value={`${o.account.platform}:${o.account.id}`}
                      onSelect={() => {
                        onChange({ account: o.account, name: o.person });
                        setOpen(false);
                      }}
                    >
                      <Check className={cn(selected ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1 truncate">
                        {o.person}
                        {o.display !== o.person && <span className="text-muted-foreground"> · {o.display}</span>}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">{o.account.id}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AssignDialog({ roles, onClose }: { roles: string[]; onClose: () => void }) {
  const { assign } = useAccessMutations();
  const id = useId();
  const [platform, setPlatform] = useState<string>(PLATFORMS[0]);
  const [who, setWho] = useState<Picked | null>(null);
  const [role, setRole] = useState(roles[0] ?? "");
  const [guild, setGuild] = useState("");
  const scope: AuthScope = guild.trim() ? { type: "guild", platform, guild: guild.trim() } : { type: "global" };

  const submit = () =>
    who &&
    assign.mutate(
      { account: who.account, role, scope },
      {
        onSuccess: () => {
          notify.ok(`已指派 ${role}`);
          onClose();
        },
        onError: (e) => notify.error(e, "指派失敗"),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !assign.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>指派角色</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-5 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field label="平台" htmlFor={`${id}-p`}>
              <Select
                value={platform}
                onValueChange={(p) => {
                  setPlatform(p);
                  setWho(null);
                }}
              >
                <SelectTrigger id={`${id}-p`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="帳號" htmlFor={`${id}-a`}>
              <PersonPicker id={`${id}-a`} platform={platform} value={who} onChange={setWho} />
            </Field>
          </div>
          <Field label="角色" htmlFor={`${id}-r`}>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id={`${id}-r`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="範圍" htmlFor={`${id}-g`}>
            <Input
              id={`${id}-g`}
              className="font-mono"
              inputMode="numeric"
              placeholder="全域,或填伺服器 id"
              value={guild}
              onChange={(e) => setGuild(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={assign.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={assign.isPending} disabled={!who || !role}>
              指派
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
