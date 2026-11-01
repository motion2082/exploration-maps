// After every build, copy the plugin into your vault, if .vault-plugin-dir (not tracked by git) names its plugin folder,
// e.g. D:\Pauls Obsidian\.obsidian\plugins\ideaverse-maps. Then turn the plugin off and on (or restart Obsidian) to load it.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["main.js", "styles.css", "manifest.json"];

export const install = {
  name: "install-into-vault",
  setup(build) {
    build.onEnd(r => {
      if (r.errors.length || !existsSync(".vault-plugin-dir")) return;
      const dir = readFileSync(".vault-plugin-dir", "utf8").trim();
      if (!existsSync(dir)) { console.warn(`Not copied: ${dir} doesn't exist`); return; }
      for (const f of FILES) copyFileSync(f, join(dir, f));
      console.log(`Copied ${FILES.join(", ")} into ${dir}`);
    });
  },
};
