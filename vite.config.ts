import { defineConfig } from "vite-plus";

export default defineConfig({
  // Relative asset URLs so the build works on GitHub Pages under /fart-raft/.
  base: "./",
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    categories: {
      correctness: "error",
      suspicious: "warn",
    },
    overrides: [
      {
        files: ["src/sim/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["three", "three/*"],
                  message: "sim/ is headless. Rendering lives in src/client.",
                },
                {
                  group: ["**/client/**", "**/input/**", "**/net/**"],
                  message:
                    "sim/ must not import client, input or net. They depend on sim, not the other way round.",
                },
              ],
            },
          ],
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
    },
  },
});
