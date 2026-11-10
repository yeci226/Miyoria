import { Check, ImagePlus, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { type ChangeEvent, type CSSProperties, type ReactNode, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  addUserImage,
  BACKGROUNDS,
  type BackgroundId,
  type Density,
  removeUserImage,
  resetLook,
  setLook,
  THEME_IDS,
  THEMES,
  useLook,
  useUserImage,
} from "./appearance";

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 border-t px-4 py-3.5">
      {title && <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>}
      {children}
    </section>
  );
}

function LookSlider({
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={cn("grid gap-2", disabled && "opacity-50")}>
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        onValueChange={([v]) => {
          if (v !== undefined) onChange(v);
        }}
      />
    </div>
  );
}

function Tile({ label, selected, onClick, style }: { label: string; selected: boolean; onClick: () => void; style: CSSProperties }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onClick}
      style={style}
      className={cn(
        "relative aspect-video w-full rounded-md bg-cover bg-center outline-none ring-1 ring-line-strong transition-shadow hover:ring-foreground/50 focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-primary hover:ring-primary",
      )}
    >
      {selected && (
        <span className="absolute right-1 bottom-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" strokeWidth={3} aria-hidden />
        </span>
      )}
    </button>
  );
}

function Gallery() {
  const { background } = useLook();
  const image = useUserImage();
  const input = useRef<HTMLInputElement>(null);

  const pick = (id: BackgroundId) => setLook({ background: id });

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const result = await addUserImage(file);
    if (result === "too-big") toast.error("圖片超過 32 MB,換一張小一點的");
    else if (result === "not-an-image") toast.error("讀不出這張圖片");
    else if (result === "session-only") toast.warning("這個瀏覽器存不下圖片,重新整理後會消失");
  };

  return (
    <div className="grid grid-cols-3 gap-2" role="group" aria-label="背景">
      {BACKGROUNDS.map((b) => (
        <Tile key={b.id} label={b.label} selected={background === b.id} onClick={() => pick(b.id)} style={{ background: b.css }} />
      ))}
      {image && (
        <div className="relative">
          <Tile label="我的圖片" selected={background === "user"} onClick={() => pick("user")} style={{ backgroundImage: `url("${image}")` }} />
          <button
            type="button"
            aria-label="移除我的圖片"
            title="移除我的圖片"
            onClick={() => void removeUserImage()}
            className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/70 text-foreground outline-none hover:bg-black focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      )}
      <button
        type="button"
        aria-label={image ? "換一張圖片" : "加入圖片"}
        title={image ? "換一張圖片" : "加入圖片"}
        onClick={() => input.current?.click()}
        className="flex aspect-video w-full items-center justify-center rounded-md bg-control text-muted-foreground outline-none transition-colors hover:bg-control-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ImagePlus className="size-4" aria-hidden />
      </button>
      <input ref={input} type="file" accept="image/*" hidden aria-hidden tabIndex={-1} onChange={(e) => void onFile(e)} />
    </div>
  );
}

/** The header's appearance button: a preference of this browser, nothing reaches the Core. */
export function AppearancePopover() {
  const look = useLook();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label="外觀設定" title="外觀設定" className="data-[state=open]:bg-control-hover">
          <SlidersHorizontal />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={16}
        aria-label="外觀設定"
        className="max-h-(--radix-popover-content-available-height) w-[19rem] overflow-y-auto rounded-lg p-0"
      >
        <header className="flex h-11 items-center justify-between gap-3 pr-2 pl-4">
          <h2 className="text-[13px] font-semibold">外觀</h2>
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={resetLook}>
            <RotateCcw />
            重設
          </Button>
        </header>
        <Group>
          <LookSlider label="背景亮度" value={look.brightness} min={30} max={100} unit="%" onChange={(brightness) => setLook({ brightness })} />
          <LookSlider label="背景模糊" value={look.backgroundBlur} min={0} max={24} unit=" px" onChange={(backgroundBlur) => setLook({ backgroundBlur })} />
        </Group>
        <Group>
          <label className="flex items-center justify-between gap-3 text-[13px]">
            玻璃模式
            <Switch checked={look.glass} onCheckedChange={(glass) => setLook({ glass })} aria-label="玻璃模式" />
          </label>
          <LookSlider label="元件模糊" value={look.elementBlur} min={0} max={24} unit=" px" disabled={!look.glass} onChange={(elementBlur) => setLook({ elementBlur })} />
          <LookSlider label="元件深色遮罩" value={look.elementMask} min={0} max={100} unit="%" disabled={!look.glass} onChange={(elementMask) => setLook({ elementMask })} />
        </Group>
        <Group title="配色">
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="配色">
            {THEME_IDS.map((id) => {
              const t = THEMES[id];
              const on = look.theme === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setLook({ theme: id })}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2.5 text-xs outline-none ring-1 ring-border transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                    on && "bg-control ring-primary",
                  )}
                >
                  <span aria-hidden className="flex">
                    <span className="size-2.5 rounded-full" style={{ background: t.primary }} />
                    <span className="-ml-1 size-2.5 rounded-full" style={{ background: t.secondary }} />
                  </span>
                  {t.label}
                </button>
              );
            })}
          </div>
        </Group>
        <Group title="密度">
          <Segmented<Density>
            className="justify-self-start"
            label="密度"
            value={look.density}
            onChange={(density) => setLook({ density })}
            options={[
              { value: "normal", label: "標準" },
              { value: "compact", label: "緊湊" },
            ]}
          />
        </Group>
        <Group title="背景">
          <Gallery />
        </Group>
      </PopoverContent>
    </Popover>
  );
}
