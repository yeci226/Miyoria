// Her, drawn by the page: an original chibi figure, not her Live2D model (whose licence for the
// web is not settled, v4-plan §16 row 6). A round face under dark hair, a whale-tail clip for the
// whale she is, and a stray strand on top that a pat sets swinging.
//
// The face follows the feed: her emotion picks the eyes, brows and mouth, intensity the blush;
// speaking moves the mouth, thinking lifts her eyes, a song brings notes, a pat a hand and hearts.
// Every motion is CSS on the SVG's own classes and stops under `prefers-reduced-motion`.

import { useId } from "react";
import { cn } from "@/lib/utils";

export type Face = "neutral" | "happy" | "smug" | "annoyed" | "angry" | "shy" | "sad" | "surprised" | "thinking";

const FACES: Record<string, Face> = {
  neutral: "neutral",
  happy: "happy",
  joy: "happy",
  excited: "happy",
  playful: "happy",
  proud: "smug",
  love: "shy",
  smug: "smug",
  annoyed: "annoyed",
  tired: "annoyed",
  angry: "angry",
  embarrassed: "shy",
  shy: "shy",
  sad: "sad",
  worried: "sad",
  scared: "sad",
  surprised: "surprised",
  curious: "surprised",
  confused: "surprised",
  thinking: "thinking",
};

/** The face an emotion name is drawn with; an unknown one is her resting face. */
export function faceOf(name: string): Face {
  return FACES[name.trim().toLowerCase()] ?? "neutral";
}

/** What she is up to, as far as the figure shows it. */
export type Pose = "asleep" | "idle" | "thinking" | "singing";

const INK = "#2a2340";
const SKIN = "#f8ebe7";
const HAIR = "#25233c";
const HAIR_LIGHT = "#363357";

function Eyes({ face, closed }: { face: Face; closed: boolean }) {
  const common = { fill: "none", stroke: INK, strokeWidth: 4, strokeLinecap: "round" as const };
  if (closed || face === "happy") {
    // Content arcs: ^ ^
    return (
      <g data-eyes="closed">
        <path d="M86 132 q10 -11 20 0" {...common} />
        <path d="M134 132 q10 -11 20 0" {...common} />
      </g>
    );
  }
  if (face === "angry") {
    return (
      <g data-eyes="angry">
        <path d="M87 124 l17 7 l-17 7" {...common} />
        <path d="M153 124 l-17 7 l17 7" {...common} />
      </g>
    );
  }
  if (face === "annoyed") {
    return (
      <g data-eyes="flat">
        <path d="M86 131 h20" {...common} />
        <path d="M134 131 h20" {...common} />
        <ellipse cx="99" cy="134" rx="4" ry="2.4" fill={INK} />
        <ellipse cx="147" cy="134" rx="4" ry="2.4" fill={INK} />
      </g>
    );
  }
  if (face === "smug") {
    return (
      <g data-eyes="smug">
        <path d="M86 128 q10 6 20 0" {...common} />
        <path d="M134 128 q10 6 20 0" {...common} />
        <ellipse cx="96" cy="133" rx="5" ry="3.5" fill={INK} />
        <ellipse cx="144" cy="133" rx="5" ry="3.5" fill={INK} />
      </g>
    );
  }
  const round = face === "surprised";
  const look = face === "shy" ? 5 : 0;
  const rx = round ? 7.5 : 7;
  const ry = round ? 8.5 : 10;
  return (
    <g data-eyes={round ? "round" : "open"} className="mio-blink">
      {[96, 144].map((cx) => (
        <g key={cx} transform={`translate(${look} 0)`}>
          <ellipse cx={cx} cy="131" rx={rx} ry={ry} fill={INK} />
          <ellipse cx={cx} cy={round ? 131 : 134} rx={rx - 3} ry={ry - 4} fill="var(--live-iris)" opacity="0.85" />
          <circle cx={cx - 2.5} cy="126" r="2.6" fill="#fff" />
          <circle cx={cx + 2.5} cy="136" r="1.2" fill="#fff" opacity="0.8" />
        </g>
      ))}
    </g>
  );
}

function Brows({ face }: { face: Face }) {
  const common = { fill: "none", stroke: HAIR, strokeWidth: 3, strokeLinecap: "round" as const, opacity: 0.85 };
  switch (face) {
    case "angry":
    case "annoyed":
      return (
        <g>
          <path d="M84 110 l20 6" {...common} />
          <path d="M156 110 l-20 6" {...common} />
        </g>
      );
    case "sad":
    case "shy":
      return (
        <g>
          <path d="M86 115 l18 -5" {...common} />
          <path d="M154 115 l-18 -5" {...common} />
        </g>
      );
    case "surprised":
      return (
        <g>
          <path d="M86 108 q9 -6 18 0" {...common} />
          <path d="M136 108 q9 -6 18 0" {...common} />
        </g>
      );
    case "smug":
      return (
        <g>
          <path d="M86 112 h18" {...common} />
          <path d="M136 109 q9 -4 18 2" {...common} />
        </g>
      );
    default:
      return null;
  }
}

function Mouth({ face, talking, singing }: { face: Face; talking: boolean; singing: boolean }) {
  const line = { fill: "none", stroke: INK, strokeWidth: 3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (talking || singing) {
    // One open mouth whose height the animation moves.
    return (
      <g className={cn("mio-mouth", talking && "mio-talk", singing && !talking && "mio-sing")} data-mouth="open">
        <ellipse cx="120" cy="160" rx={singing ? 6.5 : 8} ry="6.5" fill="#7a2f45" />
        <ellipse cx="120" cy="163.5" rx="4.5" ry="2.4" fill="#e37f9a" />
      </g>
    );
  }
  switch (face) {
    case "happy":
      return (
        <g data-mouth="smile">
          <path d="M108 155 q12 14 24 0 z" fill="#7a2f45" />
          <path d="M113 159 q7 5 14 0" fill="#e37f9a" />
        </g>
      );
    case "smug":
      return <path data-mouth="smirk" d="M110 158 q9 5 17 -3" {...line} />;
    case "annoyed":
      return <path data-mouth="flat" d="M112 160 h16" {...line} />;
    case "angry":
      return <path data-mouth="frown" d="M110 163 q10 -9 20 0" {...line} />;
    case "shy":
      return <path data-mouth="wave" d="M109 160 q4 -4 7 0 t7 0 t7 0" {...line} />;
    case "sad":
      return <path data-mouth="sad" d="M112 163 q8 -6 16 0" {...line} />;
    case "surprised":
      return <ellipse data-mouth="o" cx="120" cy="161" rx="5" ry="6" fill="#7a2f45" />;
    case "thinking":
      return <path data-mouth="hmm" d="M113 160 q5 -2 9 0 q3 1 6 -1" {...line} />;
    default:
      return <path data-mouth="rest" d="M113 158 q7 5 14 0" {...line} />;
  }
}

/** A heart, centred on (0, 0), about 16 wide. */
const HEART = "M0 5 C-9 -1 -8 -9 -3.5 -9 C-1.5 -9 0 -7.5 0 -6 C0 -7.5 1.5 -9 3.5 -9 C8 -9 9 -1 0 5 Z";
const NOTE = "M0 0 v-15 l9 -3 v15 M0 0 a3.4 2.6 -20 1 1 -0.1 0 M9 -3 a3.4 2.6 -20 1 1 -0.1 0";

const STYLE = `
.mio{--live-iris:var(--secondary-line,#a78bfa)}
.mio .mio-body{animation:mio-breathe 4.2s ease-in-out infinite;transform-origin:120px 250px}
.mio .mio-head{transform-origin:120px 190px;transition:transform .35s cubic-bezier(.16,1,.3,1)}
.mio .mio-strand{transform-origin:122px 62px;animation:mio-sway 5s ease-in-out infinite}
.mio .mio-blink{transform-origin:120px 131px;animation:mio-blink 5.6s infinite}
.mio .mio-talk{transform-origin:120px 158px;animation:mio-talk .24s ease-in-out infinite alternate}
.mio .mio-sing{transform-origin:120px 158px;animation:mio-talk .8s ease-in-out infinite alternate}
.mio .mio-eyesup{transform:translate(-2px,-4px);transition:transform .4s cubic-bezier(.16,1,.3,1)}
.mio .mio-eyes{transition:transform .4s cubic-bezier(.16,1,.3,1)}
.mio .mio-dot{animation:mio-dot 1.2s ease-in-out infinite}
.mio .mio-dot:nth-child(2){animation-delay:.2s}.mio .mio-dot:nth-child(3){animation-delay:.4s}
.mio .mio-note{animation:mio-note 2.4s ease-out infinite;opacity:0}
.mio g+g>.mio-note{animation-delay:1.2s}
.mio[data-patting=true] .mio-head{transform:scale(1.025,.955)}
.mio[data-patting=true] .mio-strand{animation:mio-boing .5s cubic-bezier(.16,1,.3,1) 2}
.mio .mio-hand{animation:mio-pat .42s ease-in-out 3 alternate}
.mio .mio-heart{animation:mio-heart 1.3s cubic-bezier(.16,1,.3,1) forwards;scale:1.5}
.mio .mio-zz{animation:mio-zz 3s ease-in-out infinite}
@keyframes mio-breathe{50%{transform:translateY(1.6px) scale(1.004,.996)}}
@keyframes mio-sway{50%{transform:rotate(4deg)}}
@keyframes mio-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.08)}}
@keyframes mio-talk{from{transform:scaleY(.25)}to{transform:scaleY(1)}}
@keyframes mio-dot{50%{opacity:.25}}
@keyframes mio-note{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(14px,-34px)}}
@keyframes mio-boing{0%{transform:rotate(0)}30%{transform:rotate(-16deg)}65%{transform:rotate(11deg)}100%{transform:rotate(0)}}
@keyframes mio-pat{from{transform:translate(-12px,0) rotate(-6deg)}to{transform:translate(12px,3px) rotate(6deg)}}
@keyframes mio-heart{0%{opacity:0;transform:translate(0,6px) scale(.6)}20%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx,0),-46px) scale(.9)}}
@keyframes mio-zz{50%{opacity:.35;transform:translate(3px,-4px)}}
@media (prefers-reduced-motion:reduce){.mio *{animation:none!important;transition:none!important}.mio .mio-heart{opacity:1}}
`;

export interface MascotProps {
  /** Her emotion name (`happy`, `embarrassed`, …). */
  emotion: string;
  /** 0..1 */
  intensity: number;
  speaking: boolean;
  pose: Pose;
  /** A pat is happening right now. */
  patting: boolean;
  /** Hearts on screen, by id; the page adds one per pat it sees and drops it after its flight. */
  hearts: readonly number[];
  className?: string;
}

/** Her figure. Decorative to assistive technology: the page says the same in words beside it. */
export function Mascot({ emotion, intensity, speaking, pose, patting, hearts, className }: MascotProps) {
  const clip = useId();
  const asleep = pose === "asleep";
  const face: Face = patting && !["angry", "annoyed"].includes(faceOf(emotion)) ? "happy" : faceOf(emotion);
  const blush = Math.min(1, (face === "shy" ? 0.55 : face === "happy" ? 0.3 : 0.16) + (patting ? 0.35 : 0) + intensity * 0.2);
  return (
    <svg
      viewBox="0 0 240 260"
      className={cn("mio select-none", className)}
      data-face={asleep ? "asleep" : face}
      data-pose={pose}
      data-patting={patting}
      data-speaking={speaking}
      aria-hidden
      focusable="false"
    >
      <style>{STYLE}</style>
      <defs>
        <clipPath id={clip}>
          <rect x="0" y="0" width="240" height="260" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`} opacity={asleep ? 0.55 : 1}>
        <g className="mio-body">
          {/* Shoulders: a hoodie in her second colour, hood lines and two drawstrings. */}
          <path d="M44 260 C48 222 74 204 120 202 C166 204 192 222 196 260 Z" fill="var(--secondary,#7355e8)" />
          <path d="M84 212 C96 226 144 226 156 212" fill="none" stroke="#000" strokeOpacity="0.18" strokeWidth="5" strokeLinecap="round" />
          <path d="M108 222 v20 M132 222 v20" stroke="#fff" strokeOpacity="0.75" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="108" cy="244" r="2.6" fill="#fff" opacity="0.8" />
          <circle cx="132" cy="244" r="2.6" fill="#fff" opacity="0.8" />
          <path d="M108 196 h24 v10 q-12 6 -24 0 Z" fill="#ead6d1" />

          <g className="mio-head">
            {/* Hair behind the face, down to the shoulders. */}
            <path d="M48 120 C44 66 82 42 120 42 C158 42 196 66 192 120 C194 160 186 196 170 210 L150 196 L90 196 L70 210 C54 196 46 160 48 120 Z" fill={HAIR} />
            <ellipse cx="120" cy="128" rx="64" ry="60" fill={SKIN} />
            <ellipse cx="88" cy="150" rx="11" ry="6.5" fill="var(--primary,#f29dc4)" opacity={blush} />
            <ellipse cx="152" cy="150" rx="11" ry="6.5" fill="var(--primary,#f29dc4)" opacity={blush} />
            {/* Bangs. */}
            <path d="M54 118 C56 72 86 52 120 52 C156 52 186 72 186 118 C176 100 166 92 156 90 C158 100 154 108 148 112 C146 100 140 92 130 88 C128 100 120 108 108 110 C112 100 110 92 104 88 C92 96 84 98 74 100 C78 106 72 112 54 118 Z" fill={HAIR} />
            <path d="M70 84 C82 66 104 58 124 58" fill="none" stroke={HAIR_LIGHT} strokeWidth="4" strokeLinecap="round" />
            {/* The stray strand. */}
            <path className="mio-strand" d="M120 54 C116 36 126 26 138 28 C128 32 126 42 128 54 Z" fill={HAIR} />
            {/* Whale-tail clip. */}
            <g transform="translate(172 92) rotate(28)">
              <path d="M0 0 C-4 -10 -14 -14 -20 -10 C-14 -8 -8 -4 -4 2 C-8 6 -14 8 -20 12 C-12 16 -4 12 0 4 Z" fill="var(--secondary-line,#a78bfa)" />
              <circle cx="2" cy="2" r="3.2" fill="var(--secondary-line,#a78bfa)" />
            </g>

            {asleep ? (
              <g data-eyes="asleep">
                <path d="M86 132 q10 7 20 0 M134 132 q10 7 20 0" fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round" />
                <text className="mio-zz" x="172" y="70" fill="var(--muted-foreground,#b3b1bc)" fontSize="18" fontWeight="600">
                  z
                </text>
              </g>
            ) : (
              <g className={pose === "thinking" ? "mio-eyesup" : "mio-eyes"}>
                <Eyes face={face} closed={false} />
              </g>
            )}
            {!asleep && <Brows face={face} />}
            {face === "sad" && !asleep && <path d="M150 142 q-4 8 0 12 q4 -4 0 -12 Z" fill="#9fc6f0" opacity="0.9" />}
            {asleep ? <path d="M114 160 q6 3 12 0" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" /> : <Mouth face={face} talking={speaking} singing={pose === "singing"} />}
          </g>
        </g>

        {pose === "thinking" && (
          <g fill="var(--muted-foreground,#b3b1bc)" data-thinking>
            <circle className="mio-dot" cx="186" cy="54" r="4" />
            <circle className="mio-dot" cx="199" cy="46" r="4" />
            <circle className="mio-dot" cx="212" cy="38" r="4" />
          </g>
        )}
        {pose === "singing" && (
          <g fill="none" stroke="var(--secondary-line,#a78bfa)" strokeWidth="2.6" strokeLinecap="round" data-singing>
            <g transform="translate(186 96)">
              <path className="mio-note" d={NOTE} />
            </g>
            <g transform="translate(40 104)">
              <path className="mio-note" d={NOTE} />
            </g>
          </g>
        )}
        {patting && (
          <g data-hand>
            <g className="mio-hand" style={{ transformOrigin: "120px 40px" }}>
              {/* A mitten of a hand, palm down, patting the crown. */}
              <path d="M92 50 C90 36 104 28 122 28 C140 28 154 34 152 48 C150 58 138 60 122 60 C104 60 94 58 92 50 Z" fill="#fbe3dc" stroke={INK} strokeOpacity="0.55" strokeWidth="2.2" />
              <path d="M110 58 v-6 M122 60 v-7 M134 58 v-6" stroke={INK} strokeOpacity="0.4" strokeWidth="2" strokeLinecap="round" />
            </g>
          </g>
        )}
        {hearts.map((id, i) => (
          // The position is the group's; the flight is the path's own transform.
          <g key={id} transform={`translate(${70 + ((id * 37) % 100)} ${58 + ((id * 13) % 20)})`} data-heart>
            <path
              className="mio-heart"
              d={HEART}
              fill="var(--primary,#f29dc4)"
              style={{ ["--dx" as string]: `${(i % 2 === 0 ? -1 : 1) * (6 + (id % 9))}px` }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
