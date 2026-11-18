// The karaoke demo's background video: the member page's test pattern (a 64 s counter, ~260 KB,
// no sound). Only `karaoke-demo.ts` loads this, behind `import.meta.env.DEV`, so a production build
// of the overlay has no video in it.
import url from "../../panel/src/pages/public/karaoke/demo-video.mp4?url";

export default url;
