import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "pluck",
  name: "Pluck",
  description:
    "Copy or save the HTTP history requests you select, a whole scope, or everything visible, as raw, Markdown, cURL, JSON or HAR.",
  version: "1.2.0",
  author: {
    name: "kiyomasanaki",
    email: "8407711+kiyomasanaki@users.noreply.github.com",
    url: "https://github.com/kiyomasanaki",
  },
  plugins: [
    {
      kind: "frontend",
      id: "pluck-frontend",
      name: "Pluck",
      root: "plugin",
      backend: { id: "pluck-backend" },
    },
    {
      kind: "backend",
      id: "pluck-backend",
      name: "Pluck Backend",
      root: "backend",
    },
  ],
});
