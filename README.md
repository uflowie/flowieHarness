# flowieHarness

A local web UI for pi-durable coding agents: one agent per git worktree. See [VISION.md](VISION.md).

```sh
npm install --ignore-scripts
npm run dev                  # daemon on :7878 + UI with hot reload on http://127.0.0.1:5173
FLOWIE_FAKE=1 npm run dev    # same, with a fake model (no tokens; tools still act on real files)
npm run build && npm run daemon   # built UI served by the daemon on http://127.0.0.1:7878
npm run check && npm test
```

- [daemon/](daemon/): the Node process hosting the agents; its API is in [daemon/README.md](daemon/README.md).
- [web/](web/): the React UI, built from [shadcn/ui](https://ui.shadcn.com) components (Base UI, Tailwind 4) and the
  AI Elements patterns: chat, messages, tool and reasoning traces, prompt input, model selector. Components live in
  `web/src/components/ui` (added with `npx shadcn@4.23.0 add <name>` from `web/`); flowie's own in `web/src/components`.
- [pi/](pi/): the pi monorepo as a git subtree, for reference (the packages come from npm).
