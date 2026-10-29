import { defineConfig } from "vite-plus";

export default defineConfig({
  // Relative asset URLs so the build works on GitHub Pages under /fart-raft/.
  base: "./",
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import"],
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
                  group: ["effect", "effect/*", "@effect/*"],
                  message: "sim/ is plain TypeScript. Effect lives in src/net and server/.",
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
      {
        files: ["src/client/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["effect", "effect/*", "@effect/*"],
                  message:
                    "Effect lives in src/net and server/. Reach the network through src/net/client.ts.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["src/input/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                {
                  group: ["effect", "effect/*", "@effect/*"],
                  message:
                    "Effect lives in src/net and server/. Reach the network through src/net/client.ts.",
                },
                {
                  group: ["**/client/**"],
                  message:
                    "input/ must not import client. The client depends on input, not the other way round.",
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
      "import/extensions": ["error", "always", { ignorePackages: true }],
      "import/no-named-as-default-member": "off",
      "import/no-unassigned-import": "off",
    },
  },
});
