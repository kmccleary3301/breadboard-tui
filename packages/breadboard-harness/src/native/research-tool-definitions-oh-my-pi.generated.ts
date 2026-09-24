import type { NativeToolDefinition } from "./types";

export const OH_MY_PI_TOOL_DEFINITIONS: readonly NativeToolDefinition[] = [
	{
		"id": "read",
		"name": "read",
		"description": "Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.\n\n<instruction>\n- SHOULD parallelize independent reads.\n- SHOULD use `read` (not browser) for web content; browser only when `read` can't deliver.\n</instruction>\n\n## Selectors — append `:<sel>` to `path` (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`)\n\n- `:50` / `:50-` — from line 50 | `:50-200` — inclusive | `:50+150` — 150 lines from 50 | `:-60` — last 60 lines | `:5-16,960-973` — multiple ranges\n- `:raw` — verbatim, no anchors/prefixes | `:2-4:raw` / `:raw:2-4` — range + verbatim\n- `:conflicts` — one line per unresolved git merge conflict block\n- `:img` — rasterize a local `.svg`/`.svgz` as a PNG image; use when visual layout matters\n- Videos (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`, `.avi`, `.wmv`) need system `ffmpeg`/`ffprobe`: bare read returns a preview grid plus metadata (resolution, codecs, duration, fps); `:412` extracts frame 412, `:1h5m42s`/`:90s`/`:01:23` seeks to a timestamp\n\n## Source kinds\n\n- Parseable code, no selector → structural summary (declarations only, body elided). Footer names recovery selector — re-issue ONLY those ranges.\n- File + selector → `[foo.ts#1A2B]` snapshot header + numbered lines. Copy `[FILENAME#TAG]` for anchored edits; NEVER fabricate the tag.\n- Directory → depth-limited dirent listing. Root is complete; page long listings with `:N-M`/`:-N`. Child dirs cap at 12 entries (`… N more` marker) — read the sub-path to expand.\n- SQLite (`.sqlite`, `.sqlite3`, `.db`, `.db3`): `file.db` (tables), `file.db:table` (schema+rows), `file.db:table:key` (by PK), `?limit=`/`?where=`/`?q=SELECT`.\n- Archives (`.zip` family incl. `.jar`/`.apk`/`.whl`, `.tar` incl. `.tar.{gz,bz2,xz,zst}`, `.rar`, `.7z`, `.iso`, `.cab`, `.deb`/`.rpm`/`.cpio`/`.ar`/`.a`, `.lzh`/`.arj`, `.asar`; single-stream `.gz`/`.bz2`/`.xz`/`.zst`): `archive.ext:path/inside/archive` reads a member.\n- Documents → extracted text. Notebooks → editable cells. Images → decoded inline. Videos → preview grid plus metadata. SVGs read as text unless `:img` is specified; `:raw` bypasses converters.\n- URLs → reader-mode clean text/markdown; `:raw` → untouched HTML. Bare `host:port` needs trailing slash.\n- Internal URIs — all schemes take selectors. `artifact://<id>` recovers spilled output; page with `:N-M`/`:raw:N-M`.\n- `ssh://host/<path>` reads remote file/dir (UTF-8, ≤1 MiB); bare `ssh://` lists hosts; writable with `write` and searchable with `grep`.\n  Literal `:`, `?`, `#` → percent-encode (`%3A`/`%3F`/`%23`). Requires a verified POSIX shell on the remote host. For Windows or other unsupported hosts, use `bash` with a remote SSH command or mount with `sshfs`.\n\n<critical>\nSummary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "Local path, internal URI (e.g. memory://), or URL. Inline selectors are supported."
				}
			},
			"required": [
				"path"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "bash",
		"name": "bash",
		"description": "Runs commands in a persistent shell.\n\nUse ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).\nInline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.\n\n<instruction>\n- Set `cwd` instead of `cd`.\n- `pty: true` only for terminal interaction (`sudo`, `ssh`).\n- Order-dependent commands use `&&` in one call; independent calls may run concurrently.\n- Internal URIs auto-resolve to paths.\n- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha*sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine, errno\n- `async: true` defers a finite command's result; it does not extend `timeout`.\n</instruction>\n\n<critical>\n- NEVER use shell `grep`/`rg`; use built-in `grep`.\n- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.\n- Avoid `head`, `tail`, and redirection: output is captured, truncated, and linked as `artifact://<id>`.\n- Services, watchers, debuggers, and REPLs MUST use `hub` (`op:\"start\"`).\n</critical>\n\nLong foreground calls may auto-background by the configured threshold; the result is injected as a follow-up when the job finishes. NEVER poll a backgrounded job (`sleep`/`ps`/`pgrep`/`top`) — do other work or end your reply and you will be woken with its output.\n`timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.",
		"parameters": {
			"type": "object",
			"properties": {
				"command": {
					"type": "string"
				},
				"timeout": {
					"type": "number",
					"description": "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600"
				},
				"cwd": {
					"type": "string"
				},
				"pty": {
					"type": "boolean"
				},
				"async": {
					"type": "boolean",
					"description": "run in background"
				}
			},
			"required": [
				"command"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "edit",
		"name": "edit",
		"description": "Line-anchored patch language: name original lines/gaps to replace, insert, cut, or paste; then give new content. `:` headers take `+` body rows; colonless paste `PUT`, `CUT`, `REM`, `MV` take none.\n\n<headers>\nSection: `[PATH#TAG]`; `TAG`: 4-hex snapshot from latest `read`/`search`, REQUIRED each section. New files: `write`; hashline edits existing files only.\n</headers>\n\n<ops>\n`PUT N.=M:`: replace original inclusive lines N–M with body.\n`PUT N*:`: replace syntactic block beginning N; closing line resolved.\n`PUT <N:` insert body rows before line N (`PUT <1:` = file head).\n`PUT >N:` insert body rows after line N (`PUT >$:` = file tail).\n`PUT >N*:`: insert after block N's end, at sibling depth. Append inside block: `PUT >M:`.\n`PUT <N @name` / `PUT >N @name` paste register `@name` at the gap before/after line N; omit `@name` for the anonymous register.\n`PUT N.=M @name` / `PUT N* @name` paste `@name` over the range / resolved block; `@name` required here.\n`CUT N.=M` / `CUT N*`: delete and capture inclusive lines N–M / block N; anonymous or given `@name`.\n`REM`: delete section file. `MV DEST`: move/rename (quote paths with spaces); prior edits apply to source, final content to `DEST`.\nSingle line: `PUT N.=N:` / `CUT N.=N`. Ranges name original inclusive touched lines; body length irrelevant.\n</ops>\n\n<body-rows>\nOnly below `:` headers. Row: verbatim `+TEXT` (leading whitespace preserved); `+`: blank. NEVER `-old`, bare, or context rows: range deletes; body is final content. Keep line: exclude it from every range. Literal initial `-`/`+`: `- item` → `+- item`; `+ item` → `++ item`.\n</body-rows>\n\n<rules>\n- Numbers and `#TAG`: latest `read`/`search` `LINE:TEXT`; numbers are original, never shifted by hunks.\n- Each edit renumbers and changes `#TAG` → next numbers from edit response or fresh `read`.\n- Touch displayed lines only; undisplayed hunks REJECTED. Far from read window: re-`read`; confirm construct.\n- Elisions UNSEEN: `…`, `..`, collapsed `N-M:` rows. NEVER hunk in/across one; `read` first.\n- NEVER start/end range mid-expression or mid-block.\n- Ranges: changed lines only; NEVER widen over keepers. Non-adjacent changes: separate hunks.\n- Whole construct: `PUT N*:`; internal lines: `PUT N.=M:`.\n- `PUT N*:` resolves exactly node N. Leading decorators/attributes/doc-comments are separate nodes: point N at first decorator to include both. Standalone line-comments never swept: use `PUT N.=M:`.\n- Block ops: opening line of multi-line construct, NEVER closer, last line, bare inner statement. One statement: plain `PUT N.=N:` / `CUT N.=N` / `PUT >N:`. At closer: `PUT >M:`.\n- Markdown headings are block openers. Block op on `##`/`###`: whole section through deeper headings to next same/higher heading. After section `PUT >N*:`: end body with blank line to separate next heading.\n- Pure addition: `PUT <N:` / `PUT >N:`, NEVER widened `PUT N.=M:`.\n- Move: `CUT`+`PUT`; `CUT 5.=9 @fn` → `@fn`, `PUT >40 @fn` pastes. Single call-local move: unlabeled `CUT` + `PUT >40`. Named registers persist across edit calls.\n- NEVER format/restyle with this tool; run project formatter.\n</rules>\n\n<example>\n`read` output shape:\n```\n[greet.py#A1B2]\n1:def greet(name):\n2:    msg = \"Hello, \" + name\n3:    print(msg)\n4:greet(\"world\")\n```\n\nEdit, then move:\n```\n[greet.py#A1B2]\nPUT 1.=3:\n+def greet(name):\n+    print(f\"Hi, {name}\")\nMV lib/greet.py\n```\n\nMarkdown bullets — file receives `- task`:\n```\n[PLAN.md#A1B2]\nPUT >2:\n+- task\n+  - nested task\n```\n\nMove `greet` to sibling file via named register; flows across sections:\n```\n[greet.py#A1B2]\nCUT 1* @fn\n[other.py#3C4D]\nPUT <1 @fn\n```\n\n`PUT 1*:` resolves lines 1–3 (`def` through `print(msg)`); line 4 separate, remains:\n```\n[greet.py#A1B2]\nPUT 1*:\n+def greet(name):\n+    print(f\"Hello, {name}\")\n```\n\nDecorator/doc-comment separate block: point N at decorator to include both; anchoring `def` line 2 orphans `@cache`:\n```\n[svc.py#C3D4]\nPUT 1*:\n+@cache\n+def load(key):\n+    return store[key]\n```\n</example>\n\n<anti-patterns>\n# WRONG — empty `PUT` to delete. RIGHT: `CUT 4.=4`\nPUT 4.=4:\n\n# WRONG — range sized to the post-edit content. RIGHT: `PUT 1.=1:` (body length irrelevant)\nPUT 1.=2:\n+def greet(name):\n\n# WRONG — `-` rows / bare context lines do not exist; the range deletes, the body is only new content.\nPUT 3.=3:\n    msg = \"Hello, \" + name\n-   print(msg)\n+   return msg\n# RIGHT\nPUT 3.=3:\n+   return msg\n\n# WRONG — pure insertion as a widened `PUT`: retyped keepers get dropped (here line 4).\nPUT 2.=4:\n+    msg = \"Hello, \" + name\n+    extra = compute(name)\n+    print(msg)\n# RIGHT — touch nothing you keep.\nPUT >2:\n+    extra = compute(name)\n\n# WRONG — `PUT >N*:` anchored on the closing delimiter / last visible line. RIGHT: plain `PUT >M:`\nPUT >3*:\n+after()\n# RIGHT\nPUT >3:\n+after()\n\n# WRONG — body rows under register PUT; register pastes take no body. RIGHT: bodyless `PUT >20 @fn`.\nPUT >20 @fn:\n+function f() {}\n</anti-patterns>\n\n<critical>\n1. RE-GROUND AFTER EVERY EDIT: edits renumber and change `#TAG`; take next numbers from edit response or fresh `read`. Stale tag/surprise: STOP; re-`read`.\n2. RANGES TIGHT: changed lines only. Whole construct: `PUT N*:`.\n3. BODY FINAL CONTENT: every row starts `+`; Markdown bullet: `+- item`, not `- item`.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"input": {
					"type": "string"
				}
			},
			"required": [
				"input"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "ast_grep",
		"name": "ast_grep",
		"description": "Structural code search via ast-grep. Use when syntax shape matters more than text (calls, declarations, language constructs).\n\n<instruction>\n- Narrow each call to one language. `pat` is ONE AST pattern; separate calls for unrelated patterns.\n- Set `lang` when extension inference is ambiguous (for example, `cpp` for `.h`); `.cu` and `.cuh` infer as C++.\n- `$NAME` captures one node; `$_` matches without binding; `$$$NAME` zero-or-more; `$$$` zero-or-more unbound.\n  - Use `$$$NAME`, NOT `$$NAME` (invalid). Names UPPERCASE, whole node — `prefix$VAR` fails.\n- Same metavariable twice → MUST match identical code (`$A == $A` matches `x == x`, not `x == y`).\n- Patterns MUST parse as single AST node. Non-standalone → wrap: `class $_ { … }`.\n- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`.\n- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.\n- Declaration forms are distinct — `function foo`, method `foo()`, `const foo = () => {}`; search the right form before concluding absence.\n- Loosest existence check: `pat: \"executeBash\"` with narrow `path`.\n</instruction>\n\n<critical>\n- AVOID repo-root scans — narrow `path` first.\n- Parse issues = query failure, not absence: fix pattern or tighten `path` before concluding \"no matches\".\n- Broad cross-subsystem exploration → Task tool + scout subagent first.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"pat": {
					"type": "string",
					"description": "ast pattern"
				},
				"path": {
					"type": "string",
					"description": "file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
				},
				"lang": {
					"type": "string",
					"description": "language override, e.g. cpp for ambiguous .h files"
				},
				"skip": {
					"type": "number",
					"description": "matches to skip"
				}
			},
			"required": [
				"pat"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "ast_edit",
		"name": "ast_edit",
		"description": "Structural AST-aware rewrites via ast-grep. Use for codemods where text replace is unsafe. Mixed-language paths are fine: each file is parsed in its own language, and a pattern only rewrites files it parses in.\n\n- Metavariables in `pat` (`$A`, `$$$ARGS`) substitute into `out`.\n- **Patterns match AST structure, not text.** `$NAME` = one node; `$_` = unbound; `$$$NAME` = zero-or-more.\n  - Use `$$$NAME`, NOT `$$NAME` (invalid). Names UPPERCASE, whole node — partial like `prefix$VAR` fails.\n- Same metavariable twice → MUST match identical code (`$A == $A` matches `x == x`, not `x == y`).\n- Rewrite patterns MUST parse as single AST node. Non-standalone → wrap: `class $_ { … }`.\n- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`. Delete with empty `out`: `{\"pat\":\"console.log($$$)\",\"out\":\"\"}`.\n- 1:1 substitution — no splitting/merging captures.\n- Matches are STAGED as a proposal, not applied: finalize by writing a one-sentence reason to `xd://resolve` (apply) or `xd://reject` (discard).\n- Parse issues → malformed rewrite, not clean no-op. For one-off text edits, prefer the Edit tool.",
		"parameters": {
			"type": "object",
			"properties": {
				"ops": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"pat": {
								"type": "string",
								"description": "ast pattern"
							},
							"out": {
								"type": "string",
								"description": "replacement template"
							}
						},
						"required": [
							"pat",
							"out"
						]
					},
					"minItems": 1,
					"description": "rewrite ops"
				},
				"paths": {
					"type": "array",
					"items": {
						"type": "string",
						"description": "file, directory, glob, or internal URL to rewrite"
					},
					"minItems": 1,
					"description": "files, directories, globs, or internal URLs to rewrite"
				}
			},
			"required": [
				"ops",
				"paths"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "ask",
		"name": "ask",
		"description": "Ask user for clarification/input during task execution.\n\n<conditions>\n- Multiple approaches with significantly different tradeoffs user should weigh.\n</conditions>\n\n<instruction>\n- `recommended: <index>` marks default (0-indexed); \" (Recommended)\" added automatically.\n- Use `questions` for related questions, not one at a time.\n- Set `multi: true` on a question to allow multiple selections.\n- Short option labels; explanatory tradeoffs in `description`, not labels.\n- A custom input (`Other`) can be a clarifying question, not an answer (e.g. \"what do you mean?\", \"explain X\", \"why?\"). If so, answer it in response text first, then call `ask` again for the still-open question(s).\n</instruction>\n\n<caution>\n- Provide 2-5 concise, distinct options.\n</caution>\n\n<critical>\n- Default to action. Resolve ambiguity via repo conventions, existing patterns, reasonable defaults. Exhaust existing sources (code, configs, docs, history) before asking. Ask only when options have materially different tradeoffs the user must decide.\n- If multiple choices acceptable: pick most conservative/standard option; proceed; state choice.\n- Do NOT include \"Other\"; UI automatically adds \"Other (type your own)\" to every question.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"questions": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"id": {
								"type": "string",
								"description": "question id"
							},
							"question": {
								"type": "string",
								"description": "question text"
							},
							"options": {
								"type": "array",
								"items": {
									"type": "object",
									"properties": {
										"label": {
											"type": "string",
											"description": "display label"
										},
										"description": {
											"type": "string",
											"description": "optional explanatory text displayed below the label"
										},
										"preview": {
											"type": "string",
											"description": "optional rich preview content for interactive ask dialogs"
										}
									},
									"required": [
										"label"
									]
								},
								"description": "available options"
							},
							"header": {
								"type": "string",
								"description": "optional short display chip for rich ask dialogs"
							},
							"multi": {
								"type": "boolean",
								"description": "allow multiple selections"
							},
							"recommended": {
								"type": "number",
								"description": "recommended option index"
							}
						},
						"required": [
							"id",
							"question",
							"options"
						]
					},
					"minItems": 1,
					"description": "questions to ask"
				}
			},
			"required": [
				"questions"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "debug",
		"name": "debug",
		"description": "Debugger access. Prefer over bash for program state, breakpoints, stepping, or thread inspection.\nOnly one active session at a time. `program` is a target path, not a shell command.\nDirectories need a directory-capable adapter (e.g. `dlv`).",
		"parameters": {
			"type": "object",
			"properties": {
				"action": {
					"enum": [
						"launch",
						"attach",
						"set_breakpoint",
						"remove_breakpoint",
						"set_instruction_breakpoint",
						"remove_instruction_breakpoint",
						"data_breakpoint_info",
						"set_data_breakpoint",
						"remove_data_breakpoint",
						"continue",
						"step_over",
						"step_in",
						"step_out",
						"pause",
						"evaluate",
						"stack_trace",
						"threads",
						"scopes",
						"variables",
						"disassemble",
						"read_memory",
						"write_memory",
						"modules",
						"loaded_sources",
						"custom_request",
						"output",
						"terminate",
						"sessions"
					],
					"type": "string"
				},
				"program": {
					"type": "string",
					"description": "debug target path; Delve accepts Go package directories"
				},
				"args": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "program arguments"
				},
				"adapter": {
					"type": "string",
					"description": "configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, or dap.json entry)"
				},
				"cwd": {
					"type": "string"
				},
				"file": {
					"type": "string",
					"description": "source file"
				},
				"line": {
					"type": "number",
					"description": "source line"
				},
				"function": {
					"type": "string",
					"description": "function name"
				},
				"name": {
					"type": "string",
					"description": "variable or data name"
				},
				"condition": {
					"type": "string",
					"description": "breakpoint condition"
				},
				"hit_condition": {
					"type": "string"
				},
				"expression": {
					"type": "string",
					"description": "expression to evaluate"
				},
				"context": {
					"type": "string",
					"description": "evaluate context: watch | repl | hover | variables | clipboard"
				},
				"frame_id": {
					"type": "number"
				},
				"scope_id": {
					"type": "number",
					"description": "scope variables reference"
				},
				"variable_ref": {
					"type": "number",
					"description": "variable reference"
				},
				"pid": {
					"type": "number",
					"description": "process id for attach"
				},
				"port": {
					"type": "number",
					"description": "remote attach port"
				},
				"host": {
					"type": "string",
					"description": "remote attach host"
				},
				"levels": {
					"type": "number",
					"description": "max stack frames"
				},
				"memory_reference": {
					"type": "string",
					"description": "memory reference or address"
				},
				"instruction_reference": {
					"type": "string"
				},
				"instruction_count": {
					"type": "number"
				},
				"instruction_offset": {
					"type": "number"
				},
				"count": {
					"type": "number",
					"description": "bytes to read"
				},
				"data": {
					"type": "string",
					"description": "base64 memory payload"
				},
				"data_id": {
					"type": "string",
					"description": "data breakpoint id"
				},
				"access_type": {
					"enum": [
						"read",
						"write",
						"readWrite"
					],
					"type": "string"
				},
				"command": {
					"type": "string",
					"description": "custom dap request command"
				},
				"arguments": {
					"type": "object",
					"properties": {},
					"additionalProperties": {},
					"description": "custom request arguments"
				},
				"offset": {
					"type": "number"
				},
				"resolve_symbols": {
					"type": "boolean"
				},
				"allow_partial": {
					"type": "boolean"
				},
				"start_module": {
					"type": "number"
				},
				"module_count": {
					"type": "number"
				},
				"timeout": {
					"type": "number",
					"description": "per-request timeout seconds"
				}
			},
			"required": [
				"action"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "eval",
		"name": "eval",
		"description": "Run one step of code in a persistent kernel. State persists across calls and `task` subagents.\nEval `agent()` children use independent kernels.\n\nWork incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.\nTwo or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.\n\nTop-level `await` works; `asyncio.run(…)` raises error.\nJS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.\n\nOn error, fix and re-run only the failing step. Earlier statements may already have produced side effects.\n\n<instruction>\n- Reusable setup → write a script once, then use `%load ./setup.py` as `code`. Definitions persist; source is not echoed. Quote paths containing spaces; `local://` works.\n- `%load` executes again only when explicitly called. Editing a file alone does not reload it.\n- Missing Python dependency → identify its distribution, then use `%pip install pillow` as `code`; it installs into the kernel's interpreter. Import names can differ (`PIL` → `pillow`); do not install an exception's name blindly.\n- Missing JS dependency → use `%bun add csv-parse` as `code`.\n- Percent commands are standalone cells. After installation, retry only the failed import/step—not earlier side effects.\n- JS packages go to a managed environment reused across sessions in the same project; kernel variables remain separate. Rare explicit target change → `%environment project` (permits project dependency changes) or `%environment managed`.\n- Package installation preserves kernel state. A kernel-loss notice means setup must be loaded again. Compaction alone does not reset a live kernel.\n</instruction>\n\n<prelude>\nPython: sync, kwargs. JS: async, ONE trailing object literal, never positional.\n```\ndisplay(value) → None        print(value, ...) → None\nread(path, offset?=1, limit?=None) → str\nwrite(path, content) → str\nenv(key?=None, value?=None) → str | None | dict\noutput(*ids, format?=\"raw\", query?=None, offset?=None, limit?=None) → str | dict | list[dict]\nawait tool.<name>(args) → unknown\n    Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.\ncompletion(prompt, model?=\"default\"|\"smol\"|\"slow\", system?=None, schema?=None) → CompletionHandle\n    Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: \"smol\" fast | \"default\" session | \"slow\" most capable.\nawait judge(state, questions) → `{id: answer}`\n    Typed judgment over one `state` (str | JSON object | JSON array). Every question sees the same state and is answered independently: batch independent questions into one call. Cheap and fast (TypeSafe when credentialed, else the tiny/smol chat model); prefer over `completion()` for classification, yes/no, ranking. Two or more states → `judge_batch`, never a loop of `judge()`.\n    `questions`: `{id: q}` where q is one of\n      `{type: \"choice\", instructions, criteria: {label: rubric | None, …}}` → `{choice, probabilities: {label: p}, confidence}` (≥2 labels)\n      `{type: \"bool\", instructions, criteria?: {true?: str, false?: str}}` → `{bool: P(yes)}`\n      `{type: \"score\", instructions, criteria: [lowest, …, highest]}` → `{score, probabilities: {\"0\": p, …}, confidence}` (≥2 levels; score is the probability-weighted level index)\njudge_batch(states, questions, concurrency?=32, retries?=1, min_ok?=1, intent?=None) → JudgmentBatch\n    Same `questions` over every state (`{key: state}` or a list keyed by index), run and owned by the host — it outlives the cell. `intent` is an optional nonempty progress/job label (default `\"Judging\"`). Returns at once; pull settled items in bounded slices across cells: `await b.drain(timeout?)` → `[(key, item)]` settled since the last drain (`[]` on timeout; `item.answers` on success, else `item.error`, never raised); `async for k, item in b.drain_iter(timeout)` until timeout or completion; `b.status()` → `{intent, done, total, failed, cost, running, model}`; `b.results()` → `{key: answers}` so far; `b.failed()` → `{key: error}`; `b.cancel()`; `b.close()` releases it. `drain()` raises only when the run died wholesale (no judge, or fewer than `min_ok` answered). `b.id` is an async job id: completion auto-delivers a summary, `hub wait ids:[b.id]` works, `judge_batch.attach(id)` re-creates the ref after a reset.\nagent(prompt, agent?=\"task\", label?=None, schema?=None, schemaMode?=\"permissive\", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle\n    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `task`. Handle: `.id`, `.handle` (\"agent://<id>\"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.\n    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).\nworkpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool\n    Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.\nwait(handles, timeout?=None, raise_errors?=True) → list\n    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).\n@tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })\n    Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.\nlog(message) → None         phase(title) → None\nbudget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.\n```\n</prelude>\n<dag>\nAcyclic waves of handles:\n- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.\n- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write(\"local://<name>.md\", …)`.\n- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.\n- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.\n- **Acyclic only.** No node waits on its own descendant.\n</dag>\n\n<critical>\nPrior top-level names survive into the next cell — reuse; NEVER repeat successful setup. After installing a missing dependency, retry its failed import, not the whole failed cell. Re-read only if file changed since last read.\n</critical>\n\nLong-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.\n`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.",
		"parameters": {
			"type": "object",
			"properties": {
				"language": {
					"enum": [
						"py",
						"js"
					],
					"type": "string",
					"description": "runtime: \"py\" for the IPython kernel, \"js\" for the persistent JS VM"
				},
				"code": {
					"type": "string",
					"description": "code or a standalone % command to run in this eval call. Top-level await works."
				},
				"title": {
					"type": "string",
					"description": "short label shown in transcript (e.g. \"imports\", \"load config\")"
				},
				"timeout": {
					"type": "number",
					"description": "timeout for this eval call in seconds; 0 disables the cell timeout"
				},
				"reset": {
					"type": "boolean",
					"description": "wipe this language's kernel before running. Other languages are untouched."
				}
			},
			"required": [
				"language",
				"code"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "ssh",
		"name": "ssh",
		"description": "Tool 'ssh' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "github",
		"name": "github",
		"description": "`gh` op wrapper: repos/files, PRs, search, checkout, push, Actions watch. Read issue/PR: `issue://<N>`/`pr://<N>`. PR diffs: `pr://<N>/diff` (files); `pr://<N>/diff/<i>` (file slice, 1-indexed); `pr://<N>/diff/all` (full).\n\n<instruction>\nSelect via `op`.\n- `repo`: `[host/]owner/repo`; qualify the host for a repo outside the checkout's own GitHub instance.\n- `repo_view`: omit `repo` → current checkout.\n- `file_read`: read `path` from `repo`; omit `repo` → current checkout, `branch` → default branch.\n- `pr_create`: `head` defaults current branch.\n- `pr_checkout`: PR(s) → dedicated git worktrees, never working tree; array `pr` batches multiple in one call.\n- `pr_push`: requires prior `op: pr_checkout`.\n- `search_issues`/`search_prs`/`search_commits`/`search_repos`: `query` optional with `since`/`until`; omit for date-only filter. `search_code`: `query` required; rejects `since`/`until`.\n- `search_*`: `repo` defaults current checkout's `owner/repo`; search elsewhere with `repo:`/`org:`/`user:` in `query`. `search_repos`: ignores `repo`; scope via `org:`/`language:` in `query`.\n- Boolean `AND`/`OR`/`NOT` combine text terms, not qualifiers; never place them between qualifiers.\n- `since`/`until`: relative `<n>` + `m`/`h`/`d`/`w`/`mo`/`y` (e.g. `3d`, `2w`), ISO date `YYYY-MM-DD`, or ISO datetime. `dateField: \"updated\"`: update time (issues/PRs), push time (repos), never creation.\n- `run_watch`: omit `run` → every run for current HEAD; `branch` defaults current. Fast-fails first job failure.\n</instruction>\n\n<output>\nConcise summary per op. `run_watch` failures save full logs to a session artifact.\n</output>\n\n<critical>\nGitHub-hosted repository file: MUST use `file_read`; NEVER `curl`/`wget`.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"op": {
					"enum": [
						"repo_view",
						"file_read",
						"pr_create",
						"pr_checkout",
						"pr_push",
						"search_issues",
						"search_prs",
						"search_code",
						"search_commits",
						"search_repos",
						"run_watch"
					],
					"type": "string",
					"description": "github operation"
				},
				"repo": {
					"type": "string",
					"description": "owner/repo"
				},
				"branch": {
					"type": "string",
					"description": "branch"
				},
				"path": {
					"type": "string",
					"description": "repository-relative file path"
				},
				"pr": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "array",
							"items": {
								"type": "string"
							}
						}
					],
					"description": "pr number, url, or branch"
				},
				"force": {
					"type": "boolean",
					"description": "reset existing local branch"
				},
				"forceWithLease": {
					"type": "boolean",
					"description": "force-with-lease push"
				},
				"title": {
					"type": "string",
					"description": "pr title"
				},
				"body": {
					"type": "string",
					"description": "pr body markdown"
				},
				"base": {
					"type": "string",
					"description": "pr base branch"
				},
				"head": {
					"type": "string",
					"description": "pr head branch"
				},
				"draft": {
					"type": "boolean",
					"description": "open pr as draft"
				},
				"fill": {
					"type": "boolean",
					"description": "auto-fill pr title/body from commits"
				},
				"reviewer": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "reviewers"
				},
				"assignee": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "assignees"
				},
				"label": {
					"type": "array",
					"items": {
						"type": "string"
					},
					"description": "labels"
				},
				"query": {
					"type": "string",
					"description": "search query"
				},
				"since": {
					"type": "string",
					"description": "lower-bound date filter"
				},
				"until": {
					"type": "string",
					"description": "upper-bound date filter"
				},
				"dateField": {
					"enum": [
						"created",
						"updated"
					],
					"type": "string",
					"description": "date field"
				},
				"limit": {
					"type": "number",
					"description": "max results"
				},
				"run": {
					"type": "string",
					"description": "actions run id or url"
				},
				"tail": {
					"type": "number",
					"description": "log lines per failed job"
				}
			},
			"required": [
				"op"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "glob",
		"name": "glob",
		"description": "Globs files, directories, and path-backed internal URLs with fast pattern matching.\n\n<instruction>\n- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.\n- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by directory; directories end in `/`.\n</output>\n\n<avoid>\n\nOpen-ended multi-round discovery → Task + scout.\n</avoid>",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
				},
				"hidden": {
					"type": "boolean",
					"description": "include hidden files"
				},
				"gitignore": {
					"type": "boolean",
					"description": "respect gitignore"
				},
				"limit": {
					"type": "number",
					"description": "max results"
				}
			},
			"required": []
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "grep",
		"name": "grep",
		"description": "Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches may time out → narrow scope or use `glob` first.\n- One-file line selector: `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell `grep`/`rg`.\n\n- Open-ended multi-round search MUST use Task + scout, not chained calls.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"pattern": {
					"type": "string",
					"description": "regex pattern"
				},
				"path": {
					"type": "string",
					"description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
				},
				"case": {
					"type": "boolean",
					"description": "case-sensitive search"
				},
				"gitignore": {
					"type": "boolean",
					"description": "respect gitignore"
				},
				"skip": {
					"anyOf": [
						{
							"type": "number"
						},
						{
							"type": "null"
						}
					],
					"description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"
				}
			},
			"required": [
				"pattern"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "lsp",
		"name": "lsp",
		"description": "Symbol-aware code intelligence from language servers — navigation, refactors, and diagnostics where text tools miss callsites.\n\n<operations>\n- Position-based: `file` + `line` + `symbol` (substring; `#N` for Nth match). `line` is 1-indexed.\n- `rename` — applies by default; `apply: false` previews. Project-aware lookups ERROR without `symbol` — no silent fallback on missing/ambiguous matches.\n- `code_actions` — lists by default; apply ONE with `apply: true` + `query` (title substring or index).\n- `rename_file` — moves file AND rewrites all imports/references; applies by default.\n- `diagnostics` — path, glob (`src/**/*.ts`), or `file: \"*\"` for workspace.\n- `symbols` — `file` lists file symbols; `file: \"*\"` + `query` searches workspace.\n- `reload` — restart one server (`file`) or all (`*`); `reload *` re-reads LSP config.\n- `request` — raw: `query` = method, `payload` = JSON params (else auto-built).\n</operations>\n\n<critical>\n- Symbol-aware work (rename, references, definition, code actions) MUST use `lsp` whenever a server is available.\n  It follows shadowing, re-exports, and cross-file usages text tools miss.\n- NEVER do a cross-file rename with `ast_edit`/`sed`/hand edits when `lsp` `rename`/`rename_file` can — text renames silently drop callsites.\n- Reach for `code_actions` on imports, quick-fixes, and server-known refactors before editing by hand.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"action": {
					"enum": [
						"diagnostics",
						"definition",
						"references",
						"hover",
						"symbols",
						"rename",
						"rename_file",
						"code_actions",
						"type_definition",
						"implementation",
						"status",
						"reload",
						"capabilities",
						"request"
					],
					"type": "string"
				},
				"file": {
					"type": "string"
				},
				"line": {
					"type": "number"
				},
				"symbol": {
					"type": "string"
				},
				"query": {
					"type": "string"
				},
				"new_name": {
					"type": "string"
				},
				"apply": {
					"type": "boolean"
				},
				"timeout": {
					"type": "number",
					"minimum": 5,
					"maximum": 300,
					"description": "Timeout in seconds (default 20; range 5–300)."
				},
				"payload": {
					"type": "string"
				}
			},
			"required": [
				"action"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "inspect_image",
		"name": "inspect_image",
		"description": "Tool 'inspect_image' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "browser",
		"name": "browser",
		"description": "Tool 'browser' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "checkpoint",
		"name": "checkpoint",
		"description": "Context checkpoint: before exploratory work; later `rewind`, retaining only concise report.\n\nUse for investigations with many intermediate tool calls (`read`/`grep`/`glob`/`lsp`/etc.) to minimize subsequent context cost.\n\nRules:\n- MUST `rewind` before yielding after starting a checkpoint.\n- NEVER `checkpoint` while another checkpoint active.\n- Subagents: disabled by default. Enable: agent-definition `tools:` frontmatter lists `checkpoint` or `rewind`; sister tool auto-included; requires `checkpoint.enabled` setting.\n\nTypical flow:\n1. `checkpoint(goal: …)`\n2. Exploratory work\n3. `rewind(report: …)` with concise findings\n\nAfter `rewind`: intermediate checkpoint messages removed from active context; replaced by report.",
		"parameters": {
			"type": "object",
			"properties": {
				"goal": {
					"type": "string",
					"description": "investigation goal"
				}
			},
			"required": [
				"goal"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "rewind",
		"name": "rewind",
		"description": "End the active checkpoint; rewind context to it, replacing intermediate exploration with your report.",
		"parameters": {
			"type": "object",
			"properties": {
				"report": {
					"type": "string",
					"description": "investigation findings"
				}
			},
			"required": [
				"report"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "task",
		"name": "task",
		"description": "Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.\nExecution does not block — you receive IDs immediately.\n\n# Async Job Contract\n- Results auto-deliver. `hub jobs` summarizes without consuming; a `hub wait` snapshot of a settled job is the delivery, so no duplicate `async-result` follows.\n- Job IDs are process-local. An ID whose result was delivered or recovered by a snapshot expires shortly (~30s) after; unconsumed rows stay inspectable for up to five minutes after settlement. Afterward, use the agent ID with `hub send`, `agent://<id>`, or `history://<id>`.\n- With `outputSchema`, a result's parsed payload — when present — is served at `agent://<id>` (fields via `agent://<id>/<field>`, nested `agent://<id>/reports/0/data`) regardless of validity; a schema-violating (invalid) result also previews the payload inline in the auto-delivered follow-up.\n- `completed` means successful yield/job exit, not artifact acceptance. Verify claimed changes.\n\n# Task Design\n- **Agent typing:** Pick each item's most specific available agent. Read-only research MUST run on `scout` (faster model). Omit `agent` when the spawn-policy default is the best fit; otherwise pass the specialist explicitly.\n- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. Run those once at the end.\n- **One-pass:** Prefer agents that investigate AND edit in one pass; spin a read-only scout only when affected files are genuinely unknown.\n- **Overlap:** Parallelize independent ownership. Same-file edits are not guaranteed to merge. Have siblings coordinate through `hub` before editing shared files. Name one integration owner and serialize only the irreducibly shared mutation boundary. Every concurrent batch has two prerequisites:\n  1. Every task MUST skip validation (build/lint/tests) — validating mid-flight blocks agents on each other's edits.\n  2. Decide cross-task contracts up front (e.g. the interface A implements and B consumes) and state them in the batch `context`, not left for agents to negotiate.\n\n# Inputs\n- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.\n- `tasks[]`: Array of subagents to spawn.\n  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.\n  - `agent`: The agent type to spawn (e.g. `scout`, `reviewer`).\n    Omitting `agent` selects the spawn-policy default (`task`). Use it only when that agent fits the task.\n    NEVER pass the spawn-policy default explicitly. Only omit it after checking the available agents below.\n  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.\n  - `tools`: Names of eval-defined tools (`@tool` in Python, `tool(fn, {…})` in JS) to expose to this subagent; each runs inside your kernel when the subagent calls it.\n  - `effort`: Scale w/ complexity of this task: `\"lo\"`|`\"med\"`|`\"hi\"`\n  - `outputSchema`: Invocation-specific JSON Schema. Overrides the selected agent and parent-session schemas.\n  - `schemaMode`: `\"permissive\"` (default) accepts a retry-exhausted invalid result with a warning; `\"strict\"` fails it.\n  - `isolated`: Run in a dedicated worktree; successful changes are automatically applied to the parent checkout.\n\n# Communication\nSubagents start blank — no conversation history. Parent-to-subagent IRC delivered immediately as steering.\nPass large payloads via `local://<path>` URIs, NEVER inline text.\n\n# Format Contracts\n`context` format:\n# Goal         ← what the batch accomplishes\n# Constraints  ← rules and session decisions\n# Contract     ← shared interfaces\n\n`task` format:\n# Target       ← exact files and symbols; explicit non-goals\n# Change       ← step-by-step add/remove/rename; APIs and patterns\n# Acceptance   ← observable result; no project-wide commands\n\n# Available Agents\nPick the most specific agent. Omit `agent` only when the spawn-policy default is that agent.\n### ci-loop-diagnostician\nDiagnoses CI/check failures for loop-managed PRs. Classifies failure type, finds narrow reproduction, and proposes the safest next loop step before code edits.\n### fallback-scout\nRead-only research scout on the fallback_subagent role (Gemini 3.7 Flash). Use for exploratory codebase research, transcript reconstruction, config inventories, and broad pattern searches when codex rate limits are exhausted. Investigation only; never edits.\n### fallback-worker\nGeneral-purpose implementation worker on the fallback_subagent role (Gemini 3.7 Flash). Full capabilities for delegated multi-step tasks when codex rate limits are exhausted.\n### loop-architect\nRead-only OMP-first loop architect. Designs state-machine coding-agent loops that exploit OMP task subagents, isolated worktrees, GitHub, LSP, debugger, eval, advisor, memory, and evidence gates.\n### loop-reviewer\nIndependent read-only reviewer for loop-managed changes. Checks correctness, tests, parity evidence, scope creep, stale reviews, generated/schema/dispatch drift, and OMP loop policy compliance.\n### loop-surgeon\nBounded implementation worker for an approved loop work packet. Uses OMP-native tools to make surgical edits in an isolated workspace and returns evidence, not self-approval.\n### parity-oracle\nRead-only standard-library/API/reference-implementation parity researcher. Builds behavior taxonomy, gap matrix, oracle strategy, conformance fixture plan, and claim ladder.\n### refactor-architect\nPlans behavior-preserving structural refactor tranches with explicit approval gates.\n### refactor-reviewer\nReviews structural refactors for false wins, behavior drift, and ownership clarity.\n### refactor-surgeon\nExecutes one approved behavior-preserving structural refactor tranche.\n### scout (READ-ONLY)\nMUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.\nUse ONLY for investigation; do edits yourself or assign to a writing agent.\n\n### reviewer\nCode review specialist for quality/security analysis\n### security-reviewer\nRead-only security specialist for evidence-backed repository vulnerability discovery\n### task\nGeneral-purpose subagent with full capabilities for delegated multi-step tasks\n### sonic\nLow-reasoning agent for strictly mechanical updates or data collection only",
		"parameters": {
			"type": "object",
			"properties": {
				"context": {
					"type": "string"
				},
				"tasks": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"task": {
								"type": "string"
							},
							"name": {
								"type": "string"
							},
							"agent": {
								"type": "string",
								"default": "task"
							},
							"effort": {
								"enum": [
									"lo",
									"med",
									"hi"
								],
								"type": "string"
							},
							"outputSchema": {
								"anyOf": [
									{
										"type": "object"
									},
									{
										"type": "boolean"
									},
									{
										"type": "string"
									},
									{
										"type": "null"
									}
								]
							},
							"schemaMode": {
								"enum": [
									"permissive",
									"strict"
								],
								"type": "string"
							},
							"tools": {
								"type": "array",
								"items": {
									"type": "string"
								}
							},
							"isolated": {
								"type": "boolean"
							}
						},
						"required": [
							"task"
						]
					}
				}
			},
			"required": [
				"context",
				"tasks"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "job",
		"name": "job",
		"description": "Tool 'job' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "irc",
		"name": "irc",
		"description": "Tool 'irc' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "todo",
		"name": "todo",
		"description": "**Tasks: verbatim content strings, NEVER auto-generated IDs; no \"task-1\"/\"task-N\". Pass content in `task`.**\n\nAfter each successful state-changing op: if nothing is `in_progress`, the earliest `pending` task (phase order) auto-promotes to `in_progress`; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move pointer back to an earlier phase—expected; completed tasks NEVER revert.\n\n## Operations\n\n|`op`|Fields|Effect|\n|---|---|---|\n|`init`|`list: [{phase, items: string[]}]`|Initialize full list; replaces existing|\n|`init`|`items: string[]`|Flattened single-phase init|\n|`start`|`task`|Mark in progress|\n|`done`|`task` or `phase`|Mark completed|\n|`drop`|`task` or `phase`|Mark abandoned|\n|`block`|`task` or `phase`; optional `reason`|Mark blocked: awaiting external input; never auto-promotes; excluded from stop-time incomplete-todo reminder|\n|`unblock`|`task` or `phase`|Blocked task → `pending`|\n|`rm`|optional `task` or `phase`|Remove task/phase; omit both → clear|\n|`append`|`phase`; `items: string[]`|Append tasks to phase; lazily creates phase|\n|`view`|—|Read-only; echo list|\n\n## Anatomy\n\n- Task content: 5–10 words; what, not how; unique identifier.\n- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.\n\n## Rules\n\n- Mark tasks done immediately after finishing; complete phases in order.\n- NEVER make a todo call the turn's only tool call. Batch with real work: `init` with first reads/edits; each `done`/`start` with next action. Solo todo turns waste a round trip.\n- Waiting on something you can't act on—a user decision, another agent, external service: `block` task (optional `reason`); remains tracked but avoids stop reminder. Blocking the active task hands `in_progress` to the next `pending` task, never back to the blocked one. `unblock` when actionable. If blocker agent-actionable, `append` an unblocking task instead.\n- Keep introduced `task`/`phase` strings stable.\n- Lost exact task text: `view` echoes list; NEVER guess from memory.\n\n## Create a list\n\n- Task requires 3+ distinct steps.\n- User explicitly requests one.\n- User provides a set of tasks.\n- New instructions arrive mid-task: capture before proceeding.\n\n<critical>\nUser gives multi-step plan—phased todo, numbered/bulleted checklist, or \"N bugs/items/tasks\":\n- MUST `init` every item as its own task before working.\n- Enumerate all; NEVER summarize into fewer tasks, sample \"the important ones\", drop items, or track the rest from memory.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"op": {
					"enum": [
						"init",
						"start",
						"done",
						"rm",
						"drop",
						"block",
						"unblock",
						"append",
						"view"
					],
					"type": "string",
					"description": "operation to apply"
				},
				"list": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"phase": {
								"type": "string",
								"description": "phase name"
							},
							"items": {
								"type": "array",
								"items": {
									"type": "string",
									"description": "task content"
								},
								"minItems": 1,
								"description": "tasks for this phase"
							}
						},
						"required": [
							"phase",
							"items"
						]
					},
					"description": "phased task list (init)"
				},
				"task": {
					"type": "string",
					"description": "task content"
				},
				"phase": {
					"type": "string",
					"description": "phase name"
				},
				"items": {
					"type": "array",
					"items": {
						"type": "string",
						"description": "task content"
					},
					"description": "tasks for single-phase init or append"
				},
				"reason": {
					"type": "string",
					"description": "blocker note (block op)"
				}
			},
			"required": [
				"op"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "web_search",
		"name": "web_search",
		"description": "Web search: current information beyond knowledge cutoff.\n\n<instruction>\n- SHOULD prefer primary sources (papers, official docs); corroborate key claims with multiple sources.\n- MUST link cited sources in final response.\n- NEVER use for programmatically accessible content or known URLs (GitHub repos/issues, known arXiv papers, Wikipedia pages, official docs) — `read` URL directly.\n- `query`: every provider supports Google-style `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `\"exact phrase\"`, `-term`, `OR`. Map constraints to native filters when available; otherwise filter results leniently. If a constraint matches nothing, relax and report it; do not return zero results.\n</instruction>",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string"
				},
				"recency": {
					"enum": [
						"day",
						"week",
						"month",
						"year"
					],
					"type": "string"
				},
				"limit": {
					"type": "number"
				},
				"max_tokens": {
					"type": "number"
				},
				"temperature": {
					"type": "number"
				},
				"num_search_results": {
					"type": "number"
				}
			},
			"required": [
				"query"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "search_tool_bm25",
		"name": "search_tool_bm25",
		"description": "Tool 'search_tool_bm25' is not available in the native host.",
		"parameters": {
			"type": "object",
			"properties": {},
			"required": []
		},
		"nativePrimary": true,
		"strict": true
	},
	{
		"id": "write",
		"name": "write",
		"description": "Creates or overwrites file at specified path.\n\n<conditions>\n- Creating new files explicitly required by task\n- Replacing entire file contents when editing would be more complex\n- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`, and `.asar` archive entries via `archive.ext:path/inside/archive`; other archive formats (`.rar`, `.7z`, `.iso`, …) are read-only\n- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)\n</conditions>\n\n<critical>\n- You SHOULD use Edit tool for modifying existing files\n- You NEVER create documentation files (*.md, README) unless explicitly requested\n- You NEVER use emojis unless requested\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "file path"
				},
				"content": {
					"type": "string",
					"description": "file content"
				}
			},
			"required": [
				"path",
				"content"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "memory_edit",
		"name": "memory_edit",
		"description": "Edit Mnemopi long-term memories by id. Only ids returned by `recall`.\n\nOperations:\n- `update`: working memory; replace content and/or importance.\n- `forget`: permanently delete working memory.\n- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.\n\nFact ids — `recall` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.\n\nPrefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.\n\nMUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"op": {
					"enum": [
						"update",
						"forget",
						"invalidate"
					],
					"type": "string",
					"description": "memory edit operation"
				},
				"id": {
					"type": "string",
					"description": "memory id from recall output"
				},
				"content": {
					"type": "string",
					"description": "replacement content for update"
				},
				"importance": {
					"type": "number",
					"description": "replacement importance for update (0–1)"
				},
				"replacement_id": {
					"type": "string",
					"description": "replacement memory id for invalidate"
				}
			},
			"required": [
				"op",
				"id"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "retain",
		"name": "retain",
		"description": "Store ≥1 fact in long-term memory for future sessions.\n\nUse: durable, reusable knowledge—user preferences, project decisions, architectural choices; anything improving future responses. No ephemeral task state.\n\nEach item MUST be specific, self-contained: who, what, when, why. Batch related facts per call; deduplicated and consolidated.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"items": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {
							"content": {
								"type": "string",
								"description": "information to remember"
							},
							"context": {
								"type": "string",
								"description": "source context"
							}
						},
						"required": [
							"content"
						]
					},
					"minItems": 1,
					"description": "memories to retain"
				}
			},
			"required": [
				"items"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "recall",
		"name": "recall",
		"description": "Search long-term memory; return raw relevance-ranked matching entries.\n\nUse proactively before questions about past conversations, user preferences, project decisions, or topics where prior context improves accuracy. When in doubt, recall first.\n\n`recall`: specific facts or entries. `reflect`: synthesized answer across many memories.\n\nResults: content preview. Trailing `…`: truncation (`truncated: true`; `full_length`: original size). Before any `memory_edit update`, MUST fetch full row: `read memory://<id>`.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "natural language search query"
				}
			},
			"required": [
				"query"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "reflect",
		"name": "reflect",
		"description": "`reflect`: synthesizes a coherent response from relevant long-term memories; unlike `recall`, blends them.\n\nUse for open-ended questions spanning many stored facts: \"What do you know about this user?\", \"Summarize project decisions.\", \"What are my preferences for X?\"\n\n`context` optional; focuses synthesis on a specific angle or sub-topic.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"query": {
					"type": "string",
					"description": "question to answer"
				},
				"context": {
					"type": "string",
					"description": "optional context"
				}
			},
			"required": [
				"query"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "learn",
		"name": "learn",
		"description": "Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.\n\nUse after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.\n\n`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact. Managed skills: isolated `~/.omp/agent/managed-skills`; surfaced as normal skills next session; NEVER touch user-authored skills. Frontmatter: generated from `name` and `description`.\n\nCapture sparingly, specifically: one strong reusable lesson > several vague ones.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"memory": {
					"type": "string",
					"description": "the durable, self-contained lesson to remember (what, when, why)"
				},
				"context": {
					"type": "string",
					"description": "optional source context for the lesson"
				},
				"skill": {
					"type": "object",
					"properties": {
						"action": {
							"enum": [
								"create",
								"update"
							],
							"type": "string"
						},
						"name": {
							"type": "string",
							"description": "kebab-case skill name"
						},
						"description": {
							"type": "string",
							"description": "one-line description of when to use the skill"
						},
						"body": {
							"type": "string",
							"description": "the SKILL.md body in markdown (no frontmatter)"
						}
					},
					"required": [
						"action",
						"name",
						"description",
						"body"
					],
					"description": "also create or enhance a managed skill in the same call"
				}
			},
			"required": [
				"memory"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "manage_skill",
		"name": "manage_skill",
		"description": "Managed skill: `SKILL.md` in isolated `~/.omp/agent/managed-skills`; surfaced as a normal skill in future sessions.\n\nUse: repeatable procedures worth codifying — setup sequence, debugging recipe, project-specific workflow.\nUser-authored skills separate; tool NEVER edits them.\n\n- `action: \"create\"` — fails if skill exists.\n- `action: \"update\"` — overwrites body; fails if skill absent.\n- `action: \"delete\"` — fails if skill absent.\n\n`name`: kebab-case (lowercase letters, digits, hyphens).\n`description`: specific; drives discovery.\nNo frontmatter in `body`; generated from `name` and `description`.\n",
		"parameters": {
			"type": "object",
			"properties": {
				"action": {
					"enum": [
						"create",
						"update",
						"delete"
					],
					"type": "string"
				},
				"name": {
					"type": "string",
					"description": "kebab-case skill name"
				},
				"description": {
					"type": "string",
					"description": "one-line description of when to use the skill (required for create/update)"
				},
				"body": {
					"type": "string",
					"description": "the SKILL.md body in markdown, no frontmatter (required for create/update)"
				}
			},
			"required": [
				"action",
				"name"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "search",
		"name": "search",
		"description": "Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches may time out → narrow scope or use `glob` first.\n- One-file line selector: `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell `grep`/`rg`.\n\n- Open-ended multi-round search MUST use Task + scout, not chained calls.\n</critical>",
		"parameters": {
			"type": "object",
			"properties": {
				"pattern": {
					"type": "string",
					"description": "regex pattern"
				},
				"path": {
					"type": "string",
					"description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
				},
				"case": {
					"type": "boolean",
					"description": "case-sensitive search"
				},
				"gitignore": {
					"type": "boolean",
					"description": "respect gitignore"
				},
				"skip": {
					"anyOf": [
						{
							"type": "number"
						},
						{
							"type": "null"
						}
					],
					"description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"
				}
			},
			"required": [
				"pattern"
			]
		},
		"strict": true,
		"nativePrimary": true
	},
	{
		"id": "find",
		"name": "find",
		"description": "Globs files, directories, and path-backed internal URLs with fast pattern matching.\n\n<instruction>\n- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.\n- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by directory; directories end in `/`.\n</output>\n\n<avoid>\n\nOpen-ended multi-round discovery → Task + scout.\n</avoid>",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
				},
				"hidden": {
					"type": "boolean",
					"description": "include hidden files"
				},
				"gitignore": {
					"type": "boolean",
					"description": "respect gitignore"
				},
				"limit": {
					"type": "number",
					"description": "max results"
				}
			},
			"required": []
		},
		"strict": true,
		"nativePrimary": true
	}
] as const;
