import type { DirectorThoughtBody } from "@/api/types";

/** `cooked_beef×3`: what a goal waits for. */
export const wantText = (w: { item: string; count: number }): string => (w.count > 1 ? `${w.item}×${w.count}` : w.item);

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * The game director's decision trace: what she saw, what she wanted, what she chose and which
 * methods were on hold. `observation`, `want` and `held` come from a newer Core; an older one
 * leaves them out and their rows with them.
 */
export function DirectorTrace({ body }: { body: DirectorThoughtBody }) {
  return (
    <dl aria-label="導演的決定" className="grid gap-4">
      {body.trigger.length > 0 && <Row label="為什麼這時候決定">{body.trigger.join(";")}</Row>}
      {body.observation !== undefined && body.observation !== "" && (
        <Row label="她看到的">
          <pre className="max-h-64 overflow-auto rounded-md bg-well px-3 py-2 font-sans text-[13px] leading-relaxed whitespace-pre-wrap break-words">{body.observation}</pre>
        </Row>
      )}
      {body.goal && <Row label="目標">{body.goal}</Row>}
      {body.want !== undefined && body.want !== null && (
        <Row label="成功條件">
          背包裡要有 <span className="font-mono text-[13px]">{wantText(body.want)}</span>
        </Row>
      )}
      {body.action && <Row label="動作"><span className="font-mono text-[13px]">{body.action}</span></Row>}
      {body.verdict && <Row label="判定"><span className="font-mono text-[13px]">{body.verdict}</span></Row>}
      {body.held !== undefined && (
        <Row label="被擋住的方法">
          {body.held.length === 0 ? (
            <span className="text-muted-foreground">沒有</span>
          ) : (
            <ul className="grid gap-1">
              {body.held.map((h, i) => (
                <li key={i} className="font-mono text-[13px]">
                  {h}
                </li>
              ))}
            </ul>
          )}
        </Row>
      )}
      {body.commentary && <Row label="她說">{body.commentary}</Row>}
    </dl>
  );
}
