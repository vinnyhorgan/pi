# Pi Config Repo

This repository is the user's personal configuration and extension workspace for `pi`, a modular coding agent.

## Purpose

- Build a high-quality personal `pi` setup tuned to the user's workflow.
- Prefer minimal, modular, extensible solutions over heavyweight or overly opinionated ones.
- Treat this repository as configuration/product work, not as an ordinary application repo.

## What Pi Is

- `pi` is intentionally minimal and extensible.
- Core behavior should stay small.
- New capabilities should usually be added via extensions, skills, prompts, themes, or packages instead of hacking around the core model prompt.
- The user agrees with `pi` not supporting MCP directly and prefers native `pi` integrations where possible.
- Full `pi` coding agent source is available locally at `/home/dvh/Downloads/pi-mono/packages/coding-agent`.
- Before making meaningful changes in this repo, first read the `pi` coding agent `README.md`, all markdown files under its `docs/` directory, and any other directly relevant source files needed to understand the feature being changed.

## Main Goal In This Repo

- Shape `pi` into the user's ideal daily driver for agentic coding work.
- Optimize for real usage, not demos.
- Keep features polished enough for heavy personal use.
- Main coding focus in this repo: pure C programming. Web dev and scripting stay secondary; assume C-first framing when discussing work here.

## Current State

- Main active configuration lives under `agent/`.
- Default model settings are in `agent/settings.json`.
- A custom web extension exists at `agent/extensions/web-tools/`.
- Web support is implemented as native `pi` tools, not MCP.
- The web extension uses `@tavily/core` internally, but user-facing tool names and UI stay generic:
  - `web_search`
  - `web_extract`
  - `web_map`
  - `web_crawl`

## Web Extension Status

- Web tools are considered production-ready for the user's personal heavy usage.
- The extension was tested extensively in real non-interactive `pi` sessions.
- Important bugs already fixed:
  - raw API / SDK mismatch removed by moving to SDK-first implementation
  - crawl results can omit `images`
  - first fresh-session Gemini `web_search` calls sometimes emit `queries: [...]` instead of `query`
- Keep these tools stable. Do not redesign them casually.

## Preferences

- No user-facing Tavily branding.
- Favor SDK-first, typed integrations over shelling out to CLIs when building core tool support.
- Prefer small, correct changes.
- Avoid adding skills or prompt rules unless they solve a real workflow gap.
- For web behavior specifically, core support should come from tools first; skills are optional workflow polish.

## How To Work In This Repo

- First understand how `pi` itself works before changing config architecture.
- Do not assume how `pi` behaves from memory when the local source and docs are available; verify against the local `pi` source tree first.
- When implementing new capability, ask:
  - should this be an extension?
  - should this be a skill?
  - should this be a prompt template?
  - should this be a package?
- Usually prefer the smallest native `pi` mechanism that fits.
- Preserve the user's philosophy: minimal base, strong extensibility, low clutter.

## For Future Agents

- Assume the user wants to continue evolving this repository into a polished personal `pi` configuration.
- Assume prior work here has been deliberate.
- Do not replace native integrations with MCP-style approaches unless explicitly requested.
- Do not add global behavior inside `agent/AGENTS.md`, `agent/SYSTEM.md`, or `agent/APPEND_SYSTEM.md` unless the user explicitly asks for behavior that should affect all `pi` sessions.
- Repository-level notes belong here at repo root because they are about working on this configuration repo itself.

## Quality Bar

- Changes should be commit-worthy, not experimental scraps.
- Verify behavior with real `pi` runs when practical.
- For tooling work, test both success paths and realistic failure/edge paths.
- If a feature already works well, prefer polish over rewrite.
