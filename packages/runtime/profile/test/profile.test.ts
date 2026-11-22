import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OWN_NAMES,
  ownIdentity,
  Profile,
  ProfileError,
  parseProfileManifest,
} from "../src/index.js";

const PROFILES = fileURLToPath(new URL("../../../../profiles", import.meta.url));

describe("Profile", () => {
  it("interests_default_to_empty", () => {
    let m = parseProfileManifest('id = "x"\ndisplay_name = "X"');
    expect(m.interests).toEqual([]);
    m = parseProfileManifest('id = "x"\ndisplay_name = "X"\ninterests = ["海"]');
    expect(m.interests).toEqual(["海"]);
  });

  it("fills every default", () => {
    const m = parseProfileManifest(
      'id = "x"\ndisplay_name = "X"\nunknown_key = 1\n[mood]\nvalence = 0.2',
    );
    expect(m).toEqual({
      id: "x",
      display_name: "X",
      nicknames: [],
      interests: [],
      language: { primary: "zh-TW", secondary: [] },
      mood: { valence: 0.2, arousal: 0.5, energy: 0.7 },
      behavior: {
        default_channel_mode: "quiet",
        initiative: "medium",
        max_share_of_recent: 0.3,
      },
      temperament: { display: "open", emotions: {} },
      persona: { sections: ["identity", "style"] },
      llm: { purposes: {} },
    });
    expect(() => parseProfileManifest('display_name = "X"')).toThrow(ProfileError);
  });

  it("loads_the_bundled_profile", async () => {
    const p = await Profile.load(PROFILES, "deepseek-chan");
    expect(p.id).toBe("deepseek-chan");
    expect(p.manifest.interests).toContain("鯨魚");
    expect(p.names()).toContain("小鯨魚");
    expect(p.manifest.llm.purposes.chat?.length).toBeGreaterThan(0);
    expect(p.personaPrompt()).not.toBe("");
    expect(p.voice).not.toBeNull();
    expect(p.avatar).not.toBeNull();
    // Her temperament: tsundere display rules, 害羞 fast, 想念 slow.
    expect(p.manifest.temperament.display).toBe("tsundere");
    expect(p.manifest.temperament.emotions.shy?.gain).toBeGreaterThan(1);
    expect(p.manifest.temperament.emotions.missing?.gain).toBeLessThan(1);
  });

  it("persona prompt: sections in order, then examples sorted by file name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-profile-"));
    try {
      writeFileSync(
        join(dir, "profile.toml"),
        'id = "t"\ndisplay_name = "T"\nnicknames = ["tt"]\n[persona]\nsections = ["b", "a"]\n',
      );
      mkdirSync(join(dir, "persona", "examples"), { recursive: true });
      writeFileSync(join(dir, "persona", "a.md"), "\n A body \n");
      writeFileSync(join(dir, "persona", "b.md"), "B body");
      writeFileSync(join(dir, "persona", "examples", "2.md"), "ex2\n");
      writeFileSync(join(dir, "persona", "examples", "1.md"), "ex1");
      writeFileSync(join(dir, "persona", "examples", "notes.txt"), "ignored");
      const p = await Profile.loadDir(dir);
      expect(p.voice).toBeNull();
      expect(p.displayName).toBe("T");
      // Her own names come with every persona.
      expect(p.names()).toEqual(["T", "tt", ...OWN_NAMES]);
      expect(p.personaPrompt()).toBe(
        `${ownIdentity("T")}\n\nB body\n\nA body\n\n# 範例對話(只示範語氣,不要照抄)\n\nex1\n\nex2`,
      );
      expect(p.ownIdentity()).toContain("本名是 Miyoria");
      expect(p.ownIdentity()).toContain("「T」");
      expect(ownIdentity("Miyoria")).not.toContain("「Miyoria」");
      // Her names as a fact, not a role she plays (and no 「角色設定」 for her to repeat: leak.ts).
      expect(ownIdentity("T")).not.toMatch(/演|角色設定/);
      p.setSection("a", "A2");
      p.setSection("c", "C");
      expect(p.sections.map((s) => s.body)).toEqual(["B body", "A2", "C"]);

      rmSync(join(dir, "persona", "a.md"));
      await expect(Profile.loadDir(dir)).rejects.toThrow(/reading persona section .*a\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ownIdentity and the character", () => {
  // The line she has always had, word for word: no profile configured changes nothing.
  const MIYORIA_AS_DEEPSEEK =
    "你的本名是 Miyoria,大家也叫你 Miyo(米優、みよ)。「DeepSeek-chan」也是你,是大家在這裡認識的你;有人叫 Miyoria、Miyo 或 DeepSeek-chan 都是在叫你。問你叫什麼,你知道自己叫 Miyoria。";
  const MIYORIA_AS_HERSELF =
    "你的本名是 Miyoria,大家也叫你 Miyo(米優、みよ)。有人叫 Miyoria 或 Miyo 都是在叫你。問你叫什麼,你知道自己叫 Miyoria。";

  it("is today's text with the default character", () => {
    expect(ownIdentity("DeepSeek-chan")).toBe(MIYORIA_AS_DEEPSEEK);
    expect(ownIdentity("miyoria")).toBe(MIYORIA_AS_HERSELF);
    expect(OWN_NAMES).toEqual(["Miyoria", "Miyo", "米優", "みよ"]);
  });

  it("names another character everywhere it named Miyoria", () => {
    const kuro = {
      name: "Kuro",
      short_name: "Ku",
      other_names: ["庫"],
      pronoun: "她",
      exchange_name: "黑市",
      creature: "貓",
    };
    expect(ownIdentity("黑貓", kuro)).toBe(
      "你的本名是 Kuro,大家也叫你 Ku(庫)。「黑貓」也是你,是大家在這裡認識的你;有人叫 Kuro、Ku 或 黑貓 都是在叫你。問你叫什麼,你知道自己叫 Kuro。",
    );
    const plain = { ...kuro, short_name: "", other_names: [] };
    expect(ownIdentity("Kuro", plain)).toBe(
      "你的本名是 Kuro,有人叫 Kuro 都是在叫你。問你叫什麼,你知道自己叫 Kuro。",
    );
    expect(ownIdentity("Kuro", plain)).not.toMatch(/Miyo|米優/);
  });

  it("comes with the loaded profile", async () => {
    const kuro = {
      name: "Kuro",
      short_name: "Ku",
      other_names: [],
      pronoun: "她",
      exchange_name: "黑市",
      creature: "貓",
    };
    const p = await Profile.load(PROFILES, "deepseek-chan", kuro);
    expect(p.character).toEqual(kuro);
    expect(p.names()).toContain("Kuro");
    expect(p.names()).not.toContain("みよ"); // 米優 is also one of this persona's nicknames
    expect(p.personaPrompt().startsWith("你的本名是 Kuro,")).toBe(true);
    const miyoria = await Profile.load(PROFILES, "deepseek-chan");
    expect(miyoria.personaPrompt().startsWith(MIYORIA_AS_DEEPSEEK)).toBe(true);
  });
});
