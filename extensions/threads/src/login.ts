// `pnpm run login`: opens her browser with a window so the owner can log in by hand, in the same
// profile folder the extension reads. Close the window when done. Not while she is scrolling: a
// profile folder can only be open once.

import { defaultProfileDir, ThreadsBrowser } from "./browser.js";

const browser = new ThreadsBrowser({
  startUrl: "https://www.threads.com/",
  profileDir: process.env.MIYORIA_THREADS_PROFILE ?? defaultProfileDir(),
  width: 720,
  height: 1000,
  headless: false,
});

await browser.launch();
console.log("在瀏覽器視窗登入她的帳號,好了就關掉視窗。");
await browser.closed();
