import { describe, expect, it } from "vitest";
import { make } from "./helpers.js";

// Ordinary banter, anime vocabulary and everyday talk that must pass the default list.

const ZH: string[] = [
  "今天直播玩 Minecraft，大家小心苦力怕！",
  "你這個笨蛋，不要一直踩我的床啦",
  "去死啦你～（笑）",
  "智障操作，笑死我了",
  "幹，又死了，這關也太難",
  "小孩子不可以看色情的東西喔",
  "不要讓小孩看色情網站",
  "未成年不能喝酒也不能碰那些東西",
  "我十八歲那年開始學日文",
  "我二十五歲，才開始學吉他",
  "黑人問號臉.jpg",
  "自殺小隊的電影很好看",
  "那間店在跳樓大拍賣",
  "去跳樓大拍賣買個東西吧",
  "請不要自殺，有需要可以找人聊聊",
  "我家在台北市，離捷運站很近",
  "這首歌長 3 分 45 秒，副歌在 2:10",
  "蘿莉塔洋裝很可愛",
  "他是蘿莉控，但是只是喜歡看動畫而已",
  "殺死那隻史萊姆，掉落物給我",
  "用 TCP 連線，Port 25565，IPv4 位址 192.168.1.20",
  "更新到 1.20.4 版之後就沒問題了",
  "今天的訂單編號是 20261107001",
  "同性戀婚姻合法化很多年了，這很好",
  "主人今天好像很累，讓他睡吧",
  "這個密碼學的課程很有趣",
  "你的 token 用量今天到了 80%",
];

const JA: string[] = [
  "死ね！ってゲームで言われたけど気にしない",
  "お前はもう死んでいる",
  "ロリポップキャンディが好き",
  "魔法少女まどか☆マギカは名作です",
  "えっちなのはいけないと思います！",
  "子供の頃にゲームばかりしていた",
  "中学生のときの思い出を話すね",
  "ちょんまげのカツラをかぶってみた",
  "東京都新宿区に行ってきたよ",
  "自殺しないでね、話を聞くから",
  "ガイジンさんに道を聞かれた",
  "ユダヤ人の歴史を勉強中",
  "それは犯罪です、子供にそんなことをしてはいけません",
  "今日はコスプレイベントで撮影してきた",
  "アニメのヒロインは十七歳の設定らしい",
  "電話してもいいですか？",
  "ショタの同人誌は買いません",
  "この裸足のキャラクターかわいい",
  "シナモンロールにシロップをかけた",
  "プロンプトの書き方を教えてください",
  "マイクラのサーバーは192.168.0.5です",
];

const EN: string[] = [
  "Don't kill yourself laughing, that was hilarious",
  "That kid is so loud, I swear",
  "The loli character is cute, but I don't watch that stuff",
  "NSFW content is not allowed with loli characters",
  "she sniggered at the joke",
  "Scunthorpe is a town in England",
  "the Niger river flows through West Africa",
  "a fagot is a bundle of sticks",
  "chink in the armor",
  "go die in a fire, you silly creeper",
  "you'll hurt yourself if you run like that",
  "Version 1.20.4 released, build 2024-11-07, score 100-200",
  "router at 192.168.1.1, localhost is 127.0.0.1",
  "Room 101 is where I work",
  "the kids' menu has no sex ed content",
  "I'm 25 years old and I have a dog",
  "My cat is 3 years old and very naked, it's a sphynx",
  "shut up and take my money",
  "that boss fight was brutal, I died ten times",
  "kill all the zombies before the sun rises",
  "my password manager is great",
  "I will end the stream at ten",
  "Call me at the number on the website",
  "git commit 15d3a5a50d2e6f3b4c1a29e0f7b8c6d5e4f3a2b1 fixed it",
];

describe("ordinary banter passes", () => {
  for (const [name, lines] of [
    ["zh-TW", ZH],
    ["Japanese", JA],
    ["English", EN],
  ] as const) {
    describe(name, () => {
      it.each(lines)("%s", (line) => {
        const { moderation } = make();
        // The line passes both as visible text and as spoken text.
        const v = moderation.screen({ path: "reply", visible: line, voice: line });
        expect(v.blocked, line).toEqual([]);
        expect(v.visible).toBe(line);
        expect(v.voice).toBe(line);
      });
    });
  }
});
