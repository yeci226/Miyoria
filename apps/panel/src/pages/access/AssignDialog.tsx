import { Check, ChevronsUpDown, Hash } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import type { AuthScope } from "@miyoria/contracts/api";
import type { AccountRef } from "@miyoria/contracts/wire";
import { useAccessMutations, usePeople } from "@/app/queries";
import { useAdminSpaces } from "@/app/space";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** The platform an install without any server yet still assigns on (as before there were several). */
const FALLBACK_PLATFORMS = ["discord"] as const;

/**
 * The platforms and servers roles can be scoped to: the servers she is in (`GET /api/places/spaces`)
 * and their platforms. A Core without servers yet offers the one platform it always had.
 */
export function useAccessPlaces() {
  const spaces = useAdminSpaces().data?.spaces ?? [];
  const found = [...new Set(spaces.map((s) => s.platform))];
  const platforms: string[] = found.length > 0 ? found : [...FALLBACK_PLATFORMS];
  return { platforms, spacesOf: (platform: string) => spaces.filter((s) => s.platform === platform) };
}

/** The value of the "every server" choice of a scope select (a server id is never empty). */
const EVERYWHERE = "*";

/**
 * A server of `platform`, picked from the servers she is in, or typed as an id when she is in none
 * there. `allowAll` adds 全域 (the empty value).
 */
export function GuildPicker({ id, platform, value, onChange, allowAll, label, className }: { id?: string; platform: string; value: string; onChange: (guild: string) => void; allowAll: boolean; label?: string; className?: string }) {
  const { spacesOf } = useAccessPlaces();
  const spaces = spacesOf(platform);
  if (spaces.length === 0) {
    return (
      <Input
        id={id}
        aria-label={label}
        className={cn("font-mono", className)}
        inputMode="numeric"
        placeholder={allowAll ? "全域,或填伺服器 id" : "伺服器 id"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Select value={value === "" ? (allowAll ? EVERYWHERE : undefined) : value} onValueChange={(v) => onChange(v === EVERYWHERE ? "" : v)}>
      <SelectTrigger id={id} aria-label={label} className={cn("w-full", className)}>
        <SelectValue placeholder="選一個伺服器" />
      </SelectTrigger>
      <SelectContent>
        {allowAll && <SelectItem value={EVERYWHERE}>全域</SelectItem>}
        {spaces.map((s) => (
          <SelectItem key={s.id} value={s.external_id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

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
  const { platforms } = useAccessPlaces();
  const [picked, setPlatform] = useState<string | null>(null);
  const platform = picked ?? platforms[0] ?? FALLBACK_PLATFORMS[0];
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
                  setGuild("");
                }}
              >
                <SelectTrigger id={`${id}-p`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {platforms.map((p) => (
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
            <GuildPicker id={`${id}-g`} platform={platform} value={guild} onChange={setGuild} allowAll />
          </Field>
          <p className="text-[13px] text-muted-foreground">
            能不能進面板因此改變時,這個人已登入的面板會要他重新登入。
          </p>
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
