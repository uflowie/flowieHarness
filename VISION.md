# flowieHarness
- herdr x pi-durable as a web ui.
- why web ui? better cross platform support for images, clipboard, syntax highlighting etc.
- why pi-durable? seems the least hacky and idiomatic way to wrap pi as a coding agent
- why ONLY pi-durable? i don't want to pay the abstraction tax around supporting every coding agent and also wanna have full ui control over pi features
- why not T3, Paseo, (...)? there are many pi-compatible UIs but this one is mine

# features
- project based side-bar. one project is a git repo. one repo can spawn worktrees based off of its current main
- image input/output
- human review with a structural diff viewer
- agent review with a result visualization and niceties for which findings to actually fix
- tool call failure min-maxing (query failed tool calls across all sessions)
- horizontal tabs per workspace that open up bespoke views for eg the topics above
- hill climb ux-critical stuff like worktree switching/creating and responsiveness

# stack
- bun or node for the daemon, whichever benchmarks better
- pi-durable
- react for prototyping and benchmark solid later for perf
