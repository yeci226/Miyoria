// What the games come with: the turtle-soup puzzles. Small on purpose.

/** One turtle-soup puzzle. `bottom` is the secret; `hints` may be said while it is unsolved. */
export interface SoupPuzzle {
  id: string;
  title: string;
  surface: string;
  bottom: string;
  hints: string[];
  /**
   * Words that give the bottom away, none of them in the surface. While the soup is unsolved she
   * may say one only once someone asked with it or a hint said it (`SoupGame.leak`): the puzzles
   * are well known, and she may know the bottom without being told.
   */
  keywords: string[];
}

export const SOUP_PUZZLES: readonly SoupPuzzle[] = [
  {
    id: "turtle",
    title: "海龜湯",
    surface: "一個男人在海邊的餐廳點了一碗海龜湯,喝了一口,臉色大變,回家之後就自殺了。為什麼?",
    bottom:
      "很多年前他和妻子遇到船難,漂到荒島上。妻子死了,同伴煮了一碗「海龜湯」給快餓死的他喝,他才活下來。今天喝到真正的海龜湯,味道完全不一樣,他才明白當年喝的是妻子的肉,承受不了而自殺。",
    hints: ["他以前喝過「海龜湯」", "他曾經遇過船難", "當年那碗湯不是用海龜煮的"],
    keywords: ["船難", "荒島", "漂流", "妻子", "老婆", "太太", "人肉", "她的肉", "吃人"],
  },
  {
    id: "lighthouse",
    title: "關燈",
    surface: "一個男人關掉了燈,上床睡覺。隔天早上他看了新聞,就自殺了。為什麼?",
    bottom:
      "他是燈塔的看守員。那天晚上他把燈塔的燈關了,一艘船看不到燈塔撞上了礁石,很多人死了。早上他從新聞知道是自己害的。",
    hints: ["他的工作和燈有關", "新聞報的是一場海難", "他住的地方在海邊"],
    keywords: ["燈塔", "看守", "船", "礁石", "海難"],
  },
  {
    id: "match",
    title: "半根火柴",
    surface: "沙漠中央有一個死去的男人,手裡握著半根火柴,附近什麼都沒有。發生了什麼事?",
    bottom:
      "他和幾個同伴搭熱氣球飛越沙漠,氣球漏氣一直往下掉,東西全丟光了還是不夠輕。大家用火柴抽籤決定誰要跳下去,他抽到了折斷的那半根,只好跳下去摔死了。",
    hints: ["他是從天上掉下來的", "他本來不是一個人", "火柴是拿來抽籤的"],
    keywords: ["熱氣球", "氣球", "抽籤", "漏氣", "折斷", "跳下"],
  },
  {
    id: "music",
    title: "音樂停了",
    surface: "音樂停了,那個女人就死了。為什麼?",
    bottom:
      "她是馬戲團走鋼索的表演者,表演時蒙著眼睛,音樂結束代表她走到了終點。那天控制音樂的人提早把音樂關掉,她以為到了,一腳踏出去就摔死了。",
    hints: ["她正在表演", "她看不到", "音樂告訴她走到哪裡了"],
    keywords: ["馬戲團", "鋼索", "蒙著眼", "蒙眼", "看不到", "表演", "終點"],
  },
  {
    id: "elevator",
    title: "七樓",
    surface:
      "一個男人住在十樓。每天早上他搭電梯到一樓;晚上回家卻只搭到七樓,再走樓梯上去。下雨天他就會直接搭到十樓。為什麼?",
    bottom: "他個子很矮,按不到十樓的按鈕,只按得到七樓。下雨天他帶著雨傘,可以用傘去按十樓。",
    hints: ["跟他的身體有關", "下雨天他會多帶一樣東西", "問題出在電梯的按鈕"],
    keywords: ["矮", "個子", "身高", "按鈕", "按不到", "按得到", "搆不到", "碰不到", "雨傘", "傘"],
  },
];
