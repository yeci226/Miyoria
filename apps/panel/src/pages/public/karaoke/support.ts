// What the browser needs to sing here, and its short name for the owner (no device names or ids).

export interface SupportScope {
  isSecureContext?: boolean;
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
}

/** Why this browser cannot sing here, or `null` when it can. */
export function missingSupport(scope: SupportScope = globalThis as SupportScope): string | null {
  if (scope.isSecureContext === false) return "這個頁面要用 https 開才能用麥克風";
  if (typeof scope.AudioContext !== "function") return "這個瀏覽器不能播放伴唱帶,請用電腦版的 Chrome 或 Edge";
  if (typeof scope.AudioWorkletNode !== "function") {
    return "這個瀏覽器不能即時抓音高,請用電腦版的 Chrome 或 Edge";
  }
  if (typeof scope.navigator?.mediaDevices?.getUserMedia !== "function") {
    return "這個瀏覽器不能用麥克風,請用電腦版的 Chrome 或 Edge";
  }
  return null;
}

/** `Chrome 131`, `Edge 131`, `Firefox 132`, `Safari 17`; else `其他`. */
export function browserName(ua: string): string {
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/(\d+)/, "Edge") ??
    pick(/OPR\/(\d+)/, "Opera") ??
    pick(/Firefox\/(\d+)/, "Firefox") ??
    pick(/(?:Chrome|CriOS)\/(\d+)/, "Chrome") ??
    pick(/Version\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//, "Safari") ??
    "其他"
  );
}

/** Why a microphone could not be opened, in words. */
export function micError(e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "沒有麥克風的權限:請在網址列旁邊允許這個網站使用麥克風,再試一次";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "找不到麥克風";
  if (name === "NotReadableError") return "麥克風被別的程式占用了";
  return "麥克風打不開";
}
