# c_index Extension — Build Specification

## Goal

Build a pi extension that lets the LLM get a structural overview of a C project in one tool call instead of reading 5-8 files for discovery. Target: medium C projects (~10k lines, ~15-20 files).

## Why tree-sitter, not clangd

- clangd needs `compile_commands.json`. Most small/medium C projects don't have one.
- clangd is an LSP daemon — lifecycle management, protocol handling, heavy.
- tree-sitter parses 10k lines of C in ~35ms. No compile database needed.
- For what the LLM needs (function signatures, struct layouts, include graph, file responsibilities), syntax-level parsing is sufficient.
- tree-sitter-c cannot expand macros or resolve types across files. This is fine. The LLM doesn't need that for structural understanding.

## Dependencies

```
tree-sitter@0.21   — MIT
tree-sitter-c@0.21 — MIT
```

Verified compatible pair. tree-sitter 0.21 is CJS (no ESM issues with pi's jiti loader). tree-sitter-c 0.21 has peer dependency on `tree-sitter@^0.21.0`.

Install: `npm install tree-sitter@0.21 tree-sitter-c@0.21` in the extension directory.

No `package.json` needed — single file extension, all deps are pi-internal except tree-sitter which needs its own `package.json` + `node_modules/`. Follow the `web-tools/` pattern: directory with `index.ts` + `package.json`.

## Extension location

```
~/.pi/agent/extensions/c-index/
├── index.ts
└── package.json
```

## Tools

### `c_index`

Project-wide structural overview. One call replaces 5-8 discovery file reads.

**Parameters:**

```typescript
{
  path: string; // directory or single file (default: ".")
  include_bodies: false; // include function bodies? (default: false, signatures only)
}
```

**Output format** (plain text, designed for LLM consumption):

```
project-name — N files, L lines
Build: <detected build command if found>

Files:
  src/foo.h    — header: M funcs, S structs, D defines
  src/bar.c    — impl: N funcs
  ...

Public API (<header files, signatures only>):
  type_t function_name(param_type param, ...);
  ...

Key types (<structs from headers>):
  struct_name { field1, field2, ... }

Include graph:
  src/main.c → src/api.h, src/util.h
  src/util.c → src/util.h
```

**Rules for output:**

- Omit #define constant values unless the symbol table is tiny (<30 defines). For large define-heavy headers, summarize: "74 constants (KRI_TRIANGLES, KRI_DEPTH_TEST, etc.)"
- Group files by role: headers first, then implementation sorted by function count
- For function signatures, use the original C signature from the source (tree-sitter gives exact text slices)
- Static functions marked with `static` prefix
- Include line count per file

**When `include_bodies: true`** — include full function bodies. This is for deep inspection of a specific file. Warning: can be large. The model should use `c_symbols` instead for per-file detail.

### `c_symbols`

Per-file detailed symbol table. Use when the model needs to understand a specific file before editing it.

**Parameters:**

```typescript
{
  path: string,       // file path (required)
  kinds: string[]     // filter: ["func", "struct", "define", "typedef", "enum", "include"]
                       // empty = all (default)
}
```

**Output format:**

```
src/kri_draw.c — 451 lines

Functions:
  static void setup_vao(const void *data, GLsizei stride, bool has_normal, bool has_color, bool has_texcoord)
  static GLenum to_gl_prim(int kri_prim)
  void kri_begin(int prim)
  void kri_vertex3f(float x, float y, float z)
  ...

Structs: (none)
Defines: VERT_SIZE, KRI_MAX_EXPANDED_VERTS
Typedefs: (none)
Enums: (none)
Includes: (none)
```

## Implementation details

### Tree-sitter extraction reference

Tested against kri codebase. These node types are reliable for C11:

**Functions:** `function_definition` — get declarator child for full signature. Check if first child is `static` for linkage.

**Function prototypes:** `declaration` — filter for lines containing `(` and not `{`.

**Structs:** `struct_specifier` — `name` field child gives struct name. `body` field child contains `field_declaration` nodes. Each field_declaration has `type` and `declarator` fields. Handle anonymous structs inside typedefs (skip duplicate — the typedef's struct_specifier will be visited separately).

**Typedefs:** `type_definition` — `declarator` field gives the typedef name. `type` field gives the underlying type.

**Enums:** `enum_specifier` — `name` field.

**Defines:** `preproc_def` — second child is the identifier, `value` field child is the value.

**Includes:** `preproc_include` — extract the full line.

**Extern declarations:** `declaration` starting with `extern`.

### Preprocessor handling

tree-sitter puts everything inside `#ifndef`/`#define`/`#endif` guard blocks under `preproc_ifdef` nodes. Walk into them — don't skip. The actual declarations are nested children of the preprocessor nodes.

For `#ifdef` with actual conditions (not just header guards), tree-sitter still parses both branches. This means the symbol table may include symbols that are conditionally compiled out. This is acceptable — the LLM can figure out conditional compilation from context.

### Static vs non-static

When walking `function_definition` nodes, check if the first child (before the return type) is a `storage_class_specifier` with text `static`. Include this in the output:

```
  static void internal_helper(int x)    // file-local
  void public_api_function(int y)       // externally visible
```

This helps the model understand public vs internal boundaries.

### Struct field extraction

For each `field_declaration` inside a struct `body`:

- `type` field child → the type specifier (e.g., `float`, `int`, `kri_vec3_t`)
- `declarator` field child → the field name (may include array brackets like `[3]`)

For the output, show field names only in `c_index` (compact). Show full type+name in `c_symbols` (detailed).

### Include graph extraction

Parse all files, collect `preproc_include` nodes. Build a map:

- Local includes (`"foo.h"`) → resolve relative to source file, map to actual path
- System includes (`<stdio.h>`) → note but don't resolve

For the graph output, show relative paths from the project root. Deduplicate. Group by file.

### Build command detection

Simple heuristic — look for build files in the project root:

- `Makefile` or `makefile` → `make`
- `premake5.lua` → `premake5 gmake && cd build && make` (or detect build/ dir)
- `CMakeLists.txt` → `mkdir -p build && cd build && cmake .. && make`
- `meson.build` → `meson setup build && cd build && ninja`

Don't parse the build file. Just suggest the most likely command. This saves the LLM from having to discover the build system.

### File discovery

Use `fs.readdirSync` + `fs.statSync` to find `.c` and `.h` files. Walk subdirectories. Skip `vendor/`, `third_party/`, `external/`, `node_modules/` directories by default. Add a `exclude_dirs` parameter if needed.

### Output token budget

For a 10k-line project (~15 files), target output:

- `c_index`: 1000-1500 tokens (~4000-6000 chars)
- `c_symbols` per file: 200-400 tokens (~800-1600 chars)

If output exceeds `DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES` (from `@mariozechner/pi-coding-agent`), use the `truncateHead` pattern from `web-tools/index.ts` — truncate and save full output to a temp JSON file.

### Error handling

- If path doesn't exist → tool error with clear message
- If no .c/.h files found → return "No C source files found in {path}"
- If tree-sitter fails to parse a file → skip it, include in output: "skipped: {filename} (parse error)"
- Never crash the tool call. Partial results > no results.

## Token savings estimate

| Scenario                  | Before (discovery reads)    | After (c_index)           |
| ------------------------- | --------------------------- | ------------------------- |
| kri (2.3k lines, 8 files) | ~12800 tokens, 5 tool calls | ~900 tokens, 1 tool call  |
| 10k lines, ~15 files      | ~25000 tokens, 8 tool calls | ~1500 tokens, 1 tool call |

The LLM still reads specific files when it needs to edit them. `c_index` replaces the discovery phase — understanding what exists before making changes.

## Existing patterns to follow

- **Extension structure**: `web-tools/` — directory with `index.ts` + `package.json`, deps in `node_modules/`
- **API key pattern**: `web-tools/index.ts` — check for env var in `createClient()`, set status bar in `session_start`, early return if missing. Adapt for tree-sitter: no API key needed, but check that tree-sitter and tree-sitter-c are importable.
- **TUI rendering**: `web-tools/index.ts` and `library-docs.ts` — `HIDDEN_COMPONENT` for partials, `Text` for call/result rendering, `renderCall`/`renderResult` methods.
- **Truncation**: `web-tools/index.ts` — `buildTextResult` with `truncateHead` + temp JSON fallback.
- **Abort handling**: `web-tools/index.ts` — `rejectOnAbort` via `Promise.race`.

## Imports

```typescript
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import Parser from "tree-sitter";
import C from "tree-sitter-c";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
```

Verify that `tree-sitter@0.21` default export works with pi's jiti loader (ESM default export from CJS package). If not, try `require()` style or add `"type": "module"` to package.json with `.mts` extension.

## Testing checklist

1. Parse kri codebase with `c_index .` — verify all 8 files, all functions, structs
2. Parse a single file with `c_symbols` — verify field-level struct detail
3. Test with path that doesn't exist — verify clean error
4. Test with empty directory — verify "No C source files found"
5. Test abort — Ctrl+C during parse of large project
6. Test output size — parse a 10k-line project, verify it fits under truncation limits
7. Test `kinds` filter on `c_symbols` — verify only requested symbol types returned
8. Test vendor exclusion — verify vendor/ directories are skipped
9. Verify tree-sitter parses successfully in pi's jiti runtime (not just raw Node)
10. Test with premake5.lua present — verify build command detection
