import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "pluck",
  name: "Pluck",
  description:
    "Pluck the request/response pairs you select out of Caido's HTTP history and copy or save them as raw, markdown, cURL, or JSON.",
  version: "1.0.0",
  author: {
    name: "iυoni",
    email: "8407711+w3spi5@users.noreply.github.com",
    url: "https://github.com/w3spi5",
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
