// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the tests use literal ${VAR} references
import { describe, expect, it } from "vitest";
import {
  formatKey,
  leaves,
  parseKey,
  parseValue,
  showValue,
  TomlDocument,
  TomlEditError,
} from "../src/toml-patch.js";
import { SAMPLE } from "./fixtures.js";

const doc = () => TomlDocument.parse(SAMPLE);
const key = parseKey;

describe("dotted keys", () => {
  it("parses_dotted_keys", () => {
    expect(key("core.profile")).toEqual(["core", "profile"]);
    expect(key('modules."voice.link".bind')).toEqual(["modules", "voice.link", "bind"]);
    expect(key("a.'b.c' . d")).toEqual(["a", "b.c", "d"]);
    expect(() => parseKey("a..b")).toThrow(TomlEditError);
    expect(() => parseKey("modules.voice/link")).toThrow(/加引號/);
    expect(() => parseKey('a."open')).toThrow(/引號沒有結束/);
    expect(formatKey(key('modules."platform.discord.bot".token'))).toBe(
      'modules."platform.discord.bot".token',
    );
  });
});

describe("TomlDocument.set", () => {
  it("replacing_a_value_keeps_comments_and_layout", () => {
    const d = doc();
    d.set(key("llm.providers.deepseek.kind"), "opencode");
    expect(d.toString()).toBe(
      SAMPLE.replace(
        'kind = "deepseek"                  # deepseek | openai',
        'kind = "opencode"                  # deepseek | openai',
      ),
    );
  });

  it("new_keys_land_in_their_table", () => {
    const d = doc();
    d.set(key("modules.api.enabled"), false);
    const text = d.toString();
    expect(text).toContain('token = "${MIYORIA_API_TOKEN:-}"\nenabled = false\n\n# voice link');
    // References elsewhere are untouched.
    expect(text).toContain('database_url = "${DATABASE_URL:-memory://}"');
    expect(text).toContain('api_key = "${LLM_API_KEY:-}"');
  });

  it("new_subtables_follow_their_parent", () => {
    const d = doc();
    d.set(key("modules.api.discord_oauth.client_id"), "${DISCORD_CLIENT_ID:-}");
    d.set(key("llm.providers.opencode.kind"), "opencode");
    const text = d.toString();
    const oauth = text.indexOf("[modules.api.discord_oauth]");
    expect(oauth).toBeGreaterThan(text.indexOf("[modules.api]"));
    expect(oauth).toBeLessThan(text.indexOf("# voice link"));
    const opencode = text.indexOf("[llm.providers.opencode]");
    expect(opencode).toBeGreaterThan(text.indexOf("[llm.providers.deepseek]"));
    expect(opencode).toBeLessThan(text.indexOf("[llm.purposes]"));
    // Brand-new top-level tables go to the end.
    d.set(key("memory.embedding.model"), "bge-m3");
    expect(d.toString().endsWith('[memory.embedding]\nmodel = "bge-m3"\n')).toBe(true);
    expect(d.toString()).not.toContain("[memory]\n");
  });

  it("keys_added_to_a_new_table_stay_together", () => {
    const d = doc();
    d.set(key("modules.api.discord_oauth.client_id"), "${DISCORD_CLIENT_ID:-}");
    d.set(key("modules.api.discord_oauth.client_secret"), "${DISCORD_CLIENT_SECRET:-}");
    expect(d.toString()).toContain(
      '[modules.api.discord_oauth]\nclient_id = "${DISCORD_CLIENT_ID:-}"\nclient_secret = "${DISCORD_CLIENT_SECRET:-}"\n\n# voice link',
    );
  });

  it("quoted_table_names_and_unset", () => {
    const d = doc();
    d.set(key('modules."voice.link".bind'), "0.0.0.0:7879");
    expect(d.toString()).toContain('[modules."voice.link"]\nbind = "0.0.0.0:7879"');
    expect(d.unset(key("core.database_url"))).toBe(true);
    expect(d.unset(key("core.nope"))).toBe(false);
    expect(d.unset(key("nope.nope"))).toBe(false);
    expect(d.toString()).not.toContain("database_url");
    expect(() => d.set(key("core.profile.x"), 1n)).toThrow("`core.profile` 是單一值,不是表格");
    expect(() => d.set(key("llm.providers"), 1n)).toThrow("`llm.providers` 是表格,不能設成單一值");
  });

  it("replaces_multi_line_values_and_keeps_the_comment", () => {
    const d = TomlDocument.parse(
      '[a]\nlist = [\n  "x", # first\n  "y",\n]   # trailing\nafter = 1\n',
    );
    d.set(["a", "list"], ["z"]);
    expect(d.toString()).toBe('[a]\nlist = ["z"]   # trailing\nafter = 1\n');
  });

  it("edits_inside_inline_tables", () => {
    const d = TomlDocument.parse('[modules.agent]\nchannels = { "1" = "always" }  # modes\n');
    d.set(key("modules.agent.channels.2"), "off");
    expect(d.toString()).toBe('[modules.agent]\nchannels = { 1 = "always", 2 = "off" }  # modes\n');
    expect(d.unset(key("modules.agent.channels.1"))).toBe(true);
    expect(d.toString()).toBe('[modules.agent]\nchannels = { 2 = "off" }  # modes\n');
  });

  it("handles_dotted_keys_crlf_and_empty_documents", () => {
    const d = TomlDocument.parse('[t]\r\nvoice.mode = "a"\r\n');
    d.set(["t", "voice", "cooldown"], 5n);
    expect(d.toString()).toBe('[t]\r\nvoice.mode = "a"\r\nvoice.cooldown = 5\r\n');
    const empty = TomlDocument.parse("");
    empty.set(["core", "profile"], "x");
    expect(empty.toString()).toBe('[core]\nprofile = "x"\n');
    const root = TomlDocument.parse("# c\n[a]\nb = 1\n");
    root.set(["top"], true);
    expect(root.data.top).toBe(true);
    expect(root.data.a).toEqual({ b: 1n });
  });

  it("unsets_whole_tables_with_their_subtables", () => {
    const d = doc();
    d.set(key("modules.api.discord_oauth.client_id"), "x");
    expect(d.unset(key("modules.api"))).toBe(true);
    const text = d.toString();
    expect(text).not.toContain("[modules.api");
    expect(text).toContain('# Admin API\n\n# voice link\n[modules."voice.link"]');
    expect(d.get(key("modules.api"))).toBeUndefined();
  });

  it("refuses_array_of_tables_edits", () => {
    const d = TomlDocument.parse('[[mcp.servers]]\nname = "a"\n');
    expect(() => d.set(["mcp", "servers", "name"], "b")).toThrow(/陣列表格/);
  });

  it("replaces_strings_in_purpose_arrays", () => {
    const profile = TomlDocument.parse(
      '[llm.purposes]\nchat       = ["deepseek:deepseek-v4"]   # main\nfast       = ["deepseek:deepseek-v4", "x:y"]\n',
    );
    expect(
      profile.replaceStringInArrays(["llm", "purposes"], "deepseek:deepseek-v4", "opencode:k2"),
    ).toBe(true);
    expect(profile.toString()).toBe(
      '[llm.purposes]\nchat       = ["opencode:k2"]   # main\nfast       = ["opencode:k2", "x:y"]\n',
    );
    expect(profile.replaceStringInArrays(["llm", "purposes"], "nope", "x")).toBe(false);
  });

  it("puts_a_new_table_after_the_trailing_comments_of_its_group", () => {
    // `miyoria config set modules.karaoke.enabled true` once landed between [modules.sing] and
    // the commented-out lines that belong to it.
    const live =
      "[modules.agent]\na = 1\n\n[modules.sing]\nb = 2\n# [modules.old]\n# c = 3\n\n[other]\nd = 4\n";
    const d = TomlDocument.parse(live);
    d.set(key("modules.karaoke.enabled"), true);
    expect(d.toString()).toBe(
      "[modules.agent]\na = 1\n\n[modules.sing]\nb = 2\n# [modules.old]\n# c = 3\n\n[modules.karaoke]\nenabled = true\n\n[other]\nd = 4\n",
    );
    expect(d.get(key("modules.karaoke.enabled"))).toBe(true);

    // At the end of the file: after the comments that close it.
    const tail = TomlDocument.parse("[modules.a]\nx = 1\n# x = 2\n# note\n");
    tail.set(key("modules.b.y"), 1n);
    expect(tail.toString()).toBe("[modules.a]\nx = 1\n# x = 2\n# note\n\n[modules.b]\ny = 1\n");
  });

  it("keeps_the_comment_block_above_the_next_table_with_that_table", () => {
    const text = "[modules.a]\nx = 1\n\n# about other\n# more\n[other]\nd = 4\n";
    const d = TomlDocument.parse(text);
    d.set(key("modules.b.y"), 1n);
    expect(d.toString()).toBe(
      "[modules.a]\nx = 1\n\n[modules.b]\ny = 1\n\n# about other\n# more\n[other]\nd = 4\n",
    );
    // A comment that touches the entries is the table's own, even right above the next table.
    const touching = TomlDocument.parse("[modules.a]\nx = 1\n# x = 2\n[other]\nd = 4\n");
    touching.set(key("modules.b.y"), 1n);
    expect(touching.toString()).toBe(
      "[modules.a]\nx = 1\n# x = 2\n\n[modules.b]\ny = 1\n[other]\nd = 4\n",
    );
  });

  it("writes_crlf_files_the_same_way", () => {
    const d = TomlDocument.parse("[modules.a]\r\nx = 1\r\n# note\r\n\r\n[other]\r\nd = 4\r\n");
    d.set(key("modules.b.y"), 1n);
    expect(d.toString()).toBe(
      "[modules.a]\r\nx = 1\r\n# note\r\n\r\n[modules.b]\r\ny = 1\r\n\r\n[other]\r\nd = 4\r\n",
    );
  });

  it("never_writes_invalid_toml", () => {
    const d = doc();
    d.set(key("core.weird"), 'quote " and \\ backslash\nnewline');
    expect(TomlDocument.parse(d.toString()).get(key("core.weird"))).toBe(
      'quote " and \\ backslash\nnewline',
    );
  });
});

describe("values", () => {
  it("parses_cli_values", () => {
    expect(parseValue("3")).toBe(3n);
    expect(parseValue("true")).toBe(true);
    expect(parseValue("debug")).toBe("debug");
    expect(parseValue('"7"')).toBe("7");
    expect(parseValue("http://x:1/a")).toBe("http://x:1/a");
    expect(parseValue("1.5")).toBe(1.5);
    expect(parseValue("a\nb = 2")).toBe("a\nb = 2");
    expect(showValue(parseValue('["a",  "b"]'))).toBe('["a", "b"]');
    expect(showValue(2.0)).toBe("2.0");
    expect(showValue({ a: 1n, "b.c": "x" })).toBe('{ a = 1, "b.c" = "x" }');
  });

  it("walks_leaves_in_document_order", () => {
    const paths = leaves(doc().data).map((l) => formatKey(l.path));
    expect(paths).toEqual([
      "core.profile",
      "core.database_url",
      "llm.providers.deepseek.kind",
      "llm.providers.deepseek.api_key",
      "llm.purposes.chat",
      "modules.api.bind",
      "modules.api.token",
      'modules."voice.link".bind',
    ]);
  });
});
