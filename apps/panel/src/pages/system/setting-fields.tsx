// One control per kind of setting, drawn from the field descriptor Core sends (`SettingField`).
// The panel checks nothing beyond what HTML can (min, max, step, max length): Core is the only
// validator and its words come back under the field.

import { Check, ChevronsUpDown, Hash, Volume2, X } from "lucide-react";
import { useState } from "react";
import type { PlaceRoom, SettingField } from "@miyoria/contracts/api";
import type { JsonValue } from "@miyoria/contracts/wire";
import { usePlaceRooms } from "@/app/queries";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input, Textarea } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export const UNIT_LABEL: Record<string, string> = { ms: "毫秒", s: "秒", min: "分鐘", h: "小時", day: "天" };
export const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** The kinds the panel draws; the others are shown as their value and changed in the file. */
export const DRAWN_KINDS = new Set(["switch", "number", "text", "select", "channel", "time", "weekday", "duration", "coins", "ratio"]);

/** A value in words, for the change log and "檔案:X". `rooms` names channels it knows. */
export function valueText(field: SettingField | undefined, value: JsonValue | null | undefined, currency: string, rooms?: Map<string, PlaceRoom>): string {
  if (value === null || value === undefined || value === "") return "沒設";
  if (Array.isArray(value)) {
    if (value.length === 0) return "沒設";
    return value.map((v) => valueText(field, v, currency, rooms)).join("、");
  }
  if (field === undefined) return typeof value === "object" ? JSON.stringify(value) : String(value);
  switch (field.kind) {
    case "switch":
      return value === true ? "開" : "關";
    case "select":
      return typeof value === "string" ? (field.labels?.[value] ?? value) : String(value);
    case "weekday":
      return typeof value === "number" ? `星期${WEEKDAYS[value] ?? value}` : String(value);
    case "duration":
      return `${value} ${UNIT_LABEL[field.unit ?? ""] ?? ""}`.trim();
    case "coins":
      return `${value} ${currency}`;
    case "ratio":
      return typeof value === "number" ? `${Math.round(value * 1000) / 10}%` : String(value);
    case "channel": {
      const room = typeof value === "string" ? rooms?.get(value) : undefined;
      return room ? `#${room.name}` : String(value);
    }
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

interface ControlProps {
  field: SettingField;
  id: string;
  value: JsonValue | null;
  onChange: (v: JsonValue) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  currency: string;
  /** A channel picker for one server's value offers only that server's channels (its platform id). */
  guild?: string | null;
}

/** A number typed in a text box: the text while it is not a number, so Core can say why. */
function NumberBox({ field, id, value, onChange, disabled, invalid, describedBy, suffix, scale = 1 }: Omit<ControlProps, "currency"> & { suffix?: string; scale?: number }) {
  const shown = typeof value === "number" ? String(Math.round(value * scale * 1000) / 1000) : (value ?? "").toString();
  const min = field.min === null ? undefined : field.min * scale;
  const max = field.max === null ? undefined : field.max * scale;
  const step = scale !== 1 ? 1 : (field.step ?? "any");
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode={field.int && scale === 1 ? "numeric" : "decimal"}
        className="w-32 tabular-nums"
        value={shown}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const text = e.target.value;
          const n = Number(text);
          onChange(text.trim() === "" || !Number.isFinite(n) ? text : n / scale);
        }}
      />
      {suffix && <span className="text-[13px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

const roomKey = (field: SettingField, r: PlaceRoom) => (field.ref === "id" ? r.id : r.context);

/** Rooms by what a field stores (a bare id or a context key). */
export function roomIndex(field: SettingField, rooms: readonly PlaceRoom[]): Map<string, PlaceRoom> {
  return new Map(rooms.map((r) => [roomKey(field, r), r]));
}

function RoomName({ room, id }: { room: PlaceRoom | undefined; id: string }) {
  if (!room) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-primary">找不到這個頻道</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{id}</span>
      </span>
    );
  }
  const Icon = room.kind === "voice" ? Volume2 : Hash;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{room.name}</span>
    </span>
  );
}

/**
 * The channel picker: the rooms of every server she is in, by server and category, from
 * `GET /api/places/rooms`. A room she cannot use is shown but cannot be picked, with why. A stored
 * room that is gone keeps its id and says so.
 */
function ChannelPicker({ field, id, value, onChange, disabled, invalid, describedBy, guild }: Omit<ControlProps, "currency">) {
  const [open, setOpen] = useState(false);
  // The names of what is stored are wanted before the picker opens.
  const rooms = usePlaceRooms(field.room, true, guild);
  const list = rooms.data?.rooms ?? [];
  const index = roomIndex(field, list);
  const picked = field.multiple ? (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []) : typeof value === "string" && value !== "" ? [value] : [];
  const ready = rooms.data?.ready ?? false;

  const toggle = (key: string) => {
    if (field.multiple) onChange(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key]);
    else {
      onChange(key);
      setOpen(false);
    }
  };
  const remove = (key: string) => onChange(field.multiple ? picked.filter((k) => k !== key) : "");

  const groups = new Map<string, PlaceRoom[]>();
  for (const r of list) {
    const title = r.category ? `${r.space.name} · ${r.category.name}` : r.space.name;
    groups.set(title, [...(groups.get(title) ?? []), r]);
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${field.label}:已選`}>
          {picked.map((key) => (
            <li key={key} className="flex max-w-full items-center gap-1 rounded-md bg-control py-0.5 pr-0.5 pl-2 text-[13px]">
              <RoomName room={index.get(key)} id={key} />
              <Button type="button" variant="ghost" size="icon-sm" className="size-6" disabled={disabled} aria-label={`拿掉 ${index.get(key)?.name ?? key}`} onClick={() => remove(key)}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            disabled={disabled}
            className="w-full max-w-sm justify-between font-normal"
          >
            <span className="text-muted-foreground">{field.multiple ? "加入頻道" : picked.length > 0 ? "換一個頻道" : "選擇頻道"}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="搜尋頻道" />
            <CommandList>
              <CommandEmpty>{rooms.isPending ? "載入中" : rooms.isError ? "讀不到頻道清單" : !ready ? "Discord 沒有連上,讀不到頻道" : "沒有符合的頻道"}</CommandEmpty>
              {[...groups].map(([title, items]) => (
                <CommandGroup key={title} heading={title}>
                  {items.map((r) => {
                    const key = roomKey(field, r);
                    const on = picked.includes(key);
                    return (
                      <CommandItem
                        key={key}
                        value={`${r.name} ${r.space.name} ${r.category?.name ?? ""} ${r.id}`}
                        disabled={!r.usable && !on}
                        onSelect={() => toggle(key)}
                        title={r.reason ?? undefined}
                      >
                        <Check className={cn("size-3.5", on ? "opacity-100" : "opacity-0")} />
                        <RoomName room={r} id={r.id} />
                        {r.reason && <span className="ml-auto truncate text-xs text-muted-foreground">{r.reason}</span>}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {!field.multiple && picked.length === 0 && <span className="sr-only">沒設</span>}
    </div>
  );
}

/** The descriptor of a one-channel pick, for choosing which channel's values to edit. */
const ROOM_FIELD: SettingField = {
  path: "",
  keys: [],
  kind: "channel",
  label: "頻道",
  help: null,
  group: null,
  order: 0,
  apply: "module",
  danger: null,
  secret: false,
  scope: "room",
  merge: "replace",
  unit: null,
  labels: null,
  room: "text",
  multiple: false,
  ref: "id",
  min: null,
  max: null,
  step: null,
  int: false,
  max_length: null,
  pattern: null,
  options: null,
  slider: false,
  long: false,
  default: null,
};

/** Which of a server's text channels to read and change the per-channel values of. */
export function RoomPicker({ id, guild, value, onChange }: { id: string; guild: string | null; value: string | null; onChange: (room: string | null) => void }) {
  return (
    <ChannelPicker
      field={ROOM_FIELD}
      id={id}
      value={value ?? ""}
      onChange={(v) => onChange(typeof v === "string" && v !== "" ? v : null)}
      disabled={false}
      invalid={false}
      describedBy={undefined}
      guild={guild}
    />
  );
}

/** The control of one field. */
export function SettingControl(props: ControlProps) {
  const { field, id, value, onChange, disabled, invalid, describedBy, currency } = props;
  const aria = { "aria-invalid": invalid || undefined, "aria-describedby": describedBy };
  switch (field.kind) {
    case "switch":
      return <Switch id={id} checked={value === true} onCheckedChange={(on) => onChange(on)} disabled={disabled} {...aria} />;
    case "number":
      return <NumberBox {...props} />;
    case "coins":
      return <NumberBox {...props} suffix={currency} />;
    case "duration":
      return <NumberBox {...props} suffix={UNIT_LABEL[field.unit ?? ""]} />;
    case "ratio":
      return <NumberBox {...props} suffix="%" scale={100} />;
    case "text":
      return field.long ? (
        <Textarea id={id} value={typeof value === "string" ? value : ""} maxLength={field.max_length ?? undefined} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />
      ) : (
        <Input id={id} className="max-w-sm" value={typeof value === "string" ? value : ""} maxLength={field.max_length ?? undefined} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />
      );
    case "time":
      return <Input id={id} type="time" className="w-32 tabular-nums" value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} {...aria} />;
    case "weekday":
      return (
        <Segmented
          label={field.label}
          className="self-start"
          value={typeof value === "number" ? String(value) : null}
          onChange={(v) => onChange(Number(v))}
          disabled={disabled}
          options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d, title: `星期${d}` }))}
        />
      );
    case "select": {
      const options = field.options ?? [];
      const label = (o: string) => field.labels?.[o] ?? o;
      if (options.length <= 4) {
        return <Segmented label={field.label} className="self-start" value={typeof value === "string" ? value : null} onChange={(v) => onChange(v)} disabled={disabled} options={options.map((o) => ({ value: o, label: label(o) }))} />;
      }
      return (
        <Select value={typeof value === "string" ? value : undefined} onValueChange={(v) => onChange(v)} disabled={disabled}>
          <SelectTrigger id={id} className="w-56" {...aria}>
            <SelectValue placeholder="選一個" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o} value={o}>
                {label(o)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case "channel":
      return <ChannelPicker {...props} />;
    default:
      return (
        <p className="text-[13px] text-muted-foreground">
          <span className="font-mono">{JSON.stringify(value)}</span> · 這種設定還不能在面板上改,請改 miyoria.toml
        </p>
      );
  }
}
