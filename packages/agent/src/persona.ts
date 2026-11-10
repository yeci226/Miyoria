import { type PersonaSection, Profile } from "@miyoria/profile";
import { serviceKey } from "@miyoria/types";
import { charCount } from "./util.js";

/**
 * Shared, runtime-editable handle to the active profile. Provided as the `PersonaHandleKey`
 * service by the agent module; edits apply from the next turn on.
 */
export class PersonaHandle {
  #profile: Profile;

  constructor(profile: Profile) {
    this.#profile = profile;
  }

  /** Runs `f` with the current profile. */
  read<R>(f: (profile: Profile) => R): R {
    return f(this.#profile);
  }

  /** A copy of the current profile. */
  snapshot(): Profile {
    const p = this.#profile;
    return new Profile({
      dir: p.dir,
      manifest: structuredClone(p.manifest),
      sections: p.sections.map((s) => ({ ...s })),
      examples: [...p.examples],
      voice: p.voice === null ? null : structuredClone(p.voice),
      avatar: p.avatar === null ? null : structuredClone(p.avatar),
    });
  }

  sections(): PersonaSection[] {
    return this.#profile.sections.map((s) => ({ ...s }));
  }

  setSection(key: string, body: string): void {
    this.#profile.setSection(key, body);
  }

  personaPrompt(): string {
    return this.#profile.personaPrompt();
  }

  /**
   * The persona sections only (character core, speaking style): the fixed system part of her
   * chat prompt. The example dialogues are data (`examples`), not rules.
   */
  corePrompt(): string {
    return [this.#profile.ownIdentity(), ...this.#profile.sections.map((s) => s.body.trim())]
      .filter((b) => b !== "")
      .join("\n\n");
  }

  /** The profile's example dialogues (`persona/examples/*.md`). */
  examples(): string[] {
    return [...this.#profile.examples];
  }

  displayName(): string {
    return this.#profile.displayName;
  }

  /** Display name and nicknames, longest first. */
  names(): string[] {
    const names: string[] = [];
    for (const raw of this.#profile.names()) {
      const name = raw.trim();
      if (name !== "" && !names.includes(name)) names.push(name);
    }
    return names.sort((a, b) => charCount(b) - charCount(a));
  }
}

/** Rust `Arc<PersonaHandle>` service. */
export const PersonaHandleKey = serviceKey<PersonaHandle>("PersonaHandle");
