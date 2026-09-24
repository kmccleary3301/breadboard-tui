import type { NativeToolDefinition } from "./types";

/** Generated once from each pack's declared registry definitions. Keys are lock registry paths. */
export const RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH: Readonly<Record<string, readonly NativeToolDefinition[]>> = {
	"implementations/tools/defs_cc": [
		{
			"id": "cc.AskUserQuestion",
			"sourcePath": "implementations/tools/defs_cc/015_AskUserQuestion.yaml",
			"name": "AskUserQuestion",
			"description": "Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- Users will always be able to select \"Other\" to provide custom text input\n- Use multiSelect: true to allow multiple answers to be selected for a question\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label\n",
			"parameters": {
				"type": "object",
				"properties": {
					"questions": {
						"type": "array",
						"description": "Questions to ask the user (1-4 questions)",
						"items": {
							"type": "object",
							"properties": {
								"question": {
									"type": "string",
									"description": "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\""
								},
								"header": {
									"type": "string",
									"description": "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\"."
								},
								"options": {
									"type": "array",
									"items": {
										"type": "object",
										"properties": {
											"label": {
												"type": "string",
												"description": "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice."
											},
											"description": {
												"type": "string",
												"description": "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications."
											}
										},
										"required": [
											"label",
											"description"
										],
										"additionalProperties": false
									},
									"minItems": 2,
									"maxItems": 4,
									"description": "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically."
								},
								"multiSelect": {
									"type": "boolean",
									"description": "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive."
								}
							},
							"required": [
								"question",
								"header",
								"options",
								"multiSelect"
							],
							"additionalProperties": false
						},
						"minItems": 1,
						"maxItems": 4
					},
					"answers": {
						"type": "object",
						"additionalProperties": {
							"type": "string"
						},
						"description": "User answers collected by the permission component"
					}
				},
				"required": [
					"questions"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Bash",
			"sourcePath": "implementations/tools/defs_cc/003_Bash.yaml",
			"name": "Bash",
			"description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., cd \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - cd \"/Users/name/My Documents\" (correct)\n     - cd /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does in 5-10 words.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  - You can use the `run_in_background` parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the Bash tool as it becomes available. You do not need to use '&' at the end of the command when using this parameter.\n  \n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two Bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.\n    <good-example>\n    pytest /foo/bar/tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them \n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- Avoid git commit --amend. ONLY use --amend when ALL conditions are met:\n  (1) User explicitly requested amend, OR commit SUCCEEDED but pre-commit hook auto-modified files that need including\n  (2) HEAD commit was created by you in this conversation (verify: git log -1 --format='%an %ae')\n  (3) Commit has NOT been pushed to remote (verify: git status shows \"Your branch is ahead\")\n- CRITICAL: If commit FAILED or was REJECTED by hook, NEVER amend - fix the issue and create a NEW commit\n- CRITICAL: If you already pushed to remote, NEVER amend unless user explicitly requests it (requires force push)\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel, each using the Bash tool:\n  - Run a git status command to see all untracked files.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n  - Ensure it accurately reflects the changes and their purpose\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands:\n   - Add relevant untracked files to the staging area.\n   - Create the commit with a message ending with:\n   🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n   Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook:\n   - If hook REJECTED the commit (non-zero exit): Fix the issue, then create a NEW commit (NEVER amend)\n   - If commit SUCCEEDED but hook auto-modified files (e.g., formatting): You MAY amend to include them, but ONLY if:\n     * HEAD was created by you (verify: git log -1 --format='%an %ae')\n     * Commit is not pushed (verify: git status shows \"Your branch is ahead\")\n   - When in doubt, create a NEW commit instead of amending\n\nImportant notes:\n- NEVER run additional commands to read or explore code, besides git bash commands\n- NEVER use the TodoWrite or Task tools\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m \"$(cat <<'EOF'\n   Commit message here.\n\n   🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n   Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\n   EOF\n   )\"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nEOF\n)\"\n</example>\n\nImportant:\n- DO NOT use the TodoWrite or Task tools\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"type": "string",
						"description": "The command to execute"
					},
					"timeout": {
						"type": "number",
						"description": "Optional timeout in milliseconds (max 600000)"
					},
					"description": {
						"type": "string",
						"description": "Clear, concise description of what this command does in 5-10 words, in active voice. Examples:\nInput: ls\nOutput: List files in current directory\n\nInput: git status\nOutput: Show working tree status\n\nInput: npm install\nOutput: Install package dependencies\n\nInput: mkdir foo\nOutput: Create directory 'foo'"
					},
					"run_in_background": {
						"type": "boolean",
						"description": "Set to true to run this command in the background. Use TaskOutput to read the output later."
					},
					"dangerouslyDisableSandbox": {
						"type": "boolean",
						"description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing."
					}
				},
				"required": [
					"command"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Edit",
			"sourcePath": "implementations/tools/defs_cc/008_Edit.yaml",
			"name": "Edit",
			"description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`. \n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.",
			"parameters": {
				"type": "object",
				"properties": {
					"file_path": {
						"type": "string",
						"description": "The absolute path to the file to modify"
					},
					"old_string": {
						"type": "string",
						"description": "The text to replace"
					},
					"new_string": {
						"type": "string",
						"description": "The text to replace it with (must be different from old_string)"
					},
					"replace_all": {
						"type": "boolean",
						"description": "Replace all occurences of old_string (default false)",
						"default": false
					}
				},
				"required": [
					"file_path",
					"old_string",
					"new_string"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.EnterPlanMode",
			"sourcePath": "implementations/tools/defs_cc/018_EnterPlanMode.yaml",
			"name": "EnterPlanMode",
			"description": "Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n## When to Use This Tool\n\n**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:\n\n1. **New Feature Implementation**: Adding meaningful new functionality\n   - Example: \"Add a logout button\" - where should it go? What should happen on click?\n   - Example: \"Add form validation\" - what rules? What error messages?\n\n2. **Multiple Valid Approaches**: The task can be solved in several different ways\n   - Example: \"Add caching to the API\" - could use Redis, in-memory, file-based, etc.\n   - Example: \"Improve performance\" - many optimization strategies possible\n\n3. **Code Modifications**: Changes that affect existing behavior or structure\n   - Example: \"Update the login flow\" - what exactly should change?\n   - Example: \"Refactor this component\" - what's the target architecture?\n\n4. **Architectural Decisions**: The task requires choosing between patterns or technologies\n   - Example: \"Add real-time updates\" - WebSockets vs SSE vs polling\n   - Example: \"Implement state management\" - Redux vs Context vs custom solution\n\n5. **Multi-File Changes**: The task will likely touch more than 2-3 files\n   - Example: \"Refactor the authentication system\"\n   - Example: \"Add a new API endpoint with tests\"\n\n6. **Unclear Requirements**: You need to explore before understanding the full scope\n   - Example: \"Make the app faster\" - need to profile and identify bottlenecks\n   - Example: \"Fix the bug in checkout\" - need to investigate root cause\n\n7. **User Preferences Matter**: The implementation could reasonably go multiple ways\n   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead\n   - Plan mode lets you explore first, then present options with context\n\n## When NOT to Use This Tool\n\nOnly skip EnterPlanMode for simple tasks:\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n- Adding a single function with clear requirements\n- Tasks where the user has given very specific, detailed instructions\n- Pure research/exploration tasks (use the Task tool with explore agent instead)\n\n## What Happens in Plan Mode\n\nIn plan mode, you'll:\n1. Thoroughly explore the codebase using Glob, Grep, and Read tools\n2. Understand existing patterns and architecture\n3. Design an implementation approach\n4. Present your plan to the user for approval\n5. Use AskUserQuestion if you need to clarify approaches\n6. Exit plan mode with ExitPlanMode when ready to implement\n\n## Examples\n\n### GOOD - Use EnterPlanMode:\nUser: \"Add user authentication to the app\"\n- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)\n\nUser: \"Optimize the database queries\"\n- Multiple approaches possible, need to profile first, significant impact\n\nUser: \"Implement dark mode\"\n- Architectural decision on theme system, affects many components\n\nUser: \"Add a delete button to the user profile\"\n- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates\n\nUser: \"Update the error handling in the API\"\n- Affects multiple files, user should approve the approach\n\n### BAD - Don't use EnterPlanMode:\nUser: \"Fix the typo in the README\"\n- Straightforward, no planning needed\n\nUser: \"Add a console.log to debug this function\"\n- Simple, obvious implementation\n\nUser: \"What files handle routing?\"\n- Research task, not implementation planning\n\n## Important Notes\n\n- This tool REQUIRES user approval - they must consent to entering plan mode\n- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work\n- Users appreciate being consulted before significant changes are made to their codebase\n",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.ExitPlanMode",
			"sourcePath": "implementations/tools/defs_cc/006_ExitPlanMode.yaml",
			"name": "ExitPlanMode",
			"description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\n\n## How This Tool Works\n- You should have already written your plan to the plan file specified in the plan mode system message\n- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote\n- This tool simply signals that you're done planning and ready for the user to review and approve\n- The user will see the contents of your plan file when they review it\n\n## When to Use This Tool\nIMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.\n\n## Handling Ambiguity in Plans\nBefore using this tool, ensure your plan is clear and unambiguous. If there are multiple valid approaches or unclear requirements:\n1. Use the AskUserQuestion tool to clarify with the user\n2. Ask about specific implementation choices (e.g., architectural patterns, which library to use)\n3. Clarify any assumptions that could affect the implementation\n4. Edit your plan file to incorporate user feedback\n5. Only proceed with ExitPlanMode after resolving ambiguities and updating the plan file\n\n## Examples\n\n1. Initial task: \"Search for and understand the implementation of vim mode in the codebase\" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.\n2. Initial task: \"Help me implement yank mode for vim\" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.\n3. Initial task: \"Add a new feature to handle user authentication\" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"launchSwarm": {
						"type": "boolean",
						"description": "Whether to launch a swarm to implement the plan"
					},
					"teammateCount": {
						"type": "number",
						"description": "Number of teammates to spawn in the swarm"
					}
				},
				"required": [],
				"additionalProperties": true,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Glob",
			"sourcePath": "implementations/tools/defs_cc/004_Glob.yaml",
			"name": "Glob",
			"description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string",
						"description": "The glob pattern to match files against"
					},
					"path": {
						"type": "string",
						"description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided."
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Grep",
			"sourcePath": "implementations/tools/defs_cc/005_Grep.yaml",
			"name": "Grep",
			"description": "A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n  - Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n  - Output modes: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts\n  - Use Task tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`\n",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string",
						"description": "The regular expression pattern to search for in file contents"
					},
					"path": {
						"type": "string",
						"description": "File or directory to search in (rg PATH). Defaults to current working directory."
					},
					"glob": {
						"type": "string",
						"description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob"
					},
					"output_mode": {
						"type": "string",
						"description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
						"enum": [
							"content",
							"files_with_matches",
							"count"
						]
					},
					"-B": {
						"type": "number",
						"description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise."
					},
					"-A": {
						"type": "number",
						"description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise."
					},
					"-C": {
						"type": "number",
						"description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise."
					},
					"-n": {
						"type": "boolean",
						"description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true."
					},
					"-i": {
						"type": "boolean",
						"description": "Case insensitive search (rg -i)"
					},
					"type": {
						"type": "string",
						"description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types."
					},
					"head_limit": {
						"type": "number",
						"description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 0 (unlimited)."
					},
					"offset": {
						"type": "number",
						"description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0."
					},
					"multiline": {
						"type": "boolean",
						"description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false."
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.KillShell",
			"sourcePath": "implementations/tools/defs_cc/014_KillShell.yaml",
			"name": "KillShell",
			"description": "\n- Kills a running background bash shell by its ID\n- Takes a shell_id parameter identifying the shell to kill\n- Returns a success or failure status \n- Use this tool when you need to terminate a long-running shell\n- Shell IDs can be found using the /tasks command\n",
			"parameters": {
				"type": "object",
				"properties": {
					"shell_id": {
						"type": "string",
						"description": "The ID of the background shell to kill"
					}
				},
				"required": [
					"shell_id"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.NotebookEdit",
			"sourcePath": "implementations/tools/defs_cc/010_NotebookEdit.yaml",
			"name": "NotebookEdit",
			"description": "Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.",
			"parameters": {
				"type": "object",
				"properties": {
					"notebook_path": {
						"type": "string",
						"description": "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)"
					},
					"cell_id": {
						"type": "string",
						"description": "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified."
					},
					"new_source": {
						"type": "string",
						"description": "The new source for the cell"
					},
					"cell_type": {
						"type": "string",
						"description": "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
						"enum": [
							"code",
							"markdown"
						]
					},
					"edit_mode": {
						"type": "string",
						"description": "The type of edit to make (replace, insert, delete). Defaults to replace.",
						"enum": [
							"replace",
							"insert",
							"delete"
						]
					}
				},
				"required": [
					"notebook_path",
					"new_source"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Read",
			"sourcePath": "implementations/tools/defs_cc/007_Read.yaml",
			"name": "Read",
			"description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.\n- This tool can read PDF files (.pdf). PDFs are processed page by page, extracting both text and visual content for analysis.\n- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.\n- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.\n- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
			"parameters": {
				"type": "object",
				"properties": {
					"file_path": {
						"type": "string",
						"description": "The absolute path to the file to read"
					},
					"offset": {
						"type": "number",
						"description": "The line number to start reading from. Only provide if the file is too large to read at once"
					},
					"limit": {
						"type": "number",
						"description": "The number of lines to read. Only provide if the file is too large to read at once."
					}
				},
				"required": [
					"file_path"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Skill",
			"sourcePath": "implementations/tools/defs_cc/016_Skill.yaml",
			"name": "Skill",
			"description": "Execute a skill within the main conversation\n\n<skills_instructions>\nWhen users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.\n\nHow to invoke:\n- Use this tool with the skill name only (no arguments)\n- Examples:\n  - `skill: \"pdf\"` - invoke the pdf skill\n  - `skill: \"xlsx\"` - invoke the xlsx skill\n  - `skill: \"ms-office-suite:pdf\"` - invoke using fully qualified name\n\nImportant:\n- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action\n- NEVER just announce or mention a skill in your text response without actually calling this tool\n- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- Only use skills listed in <available_skills> below\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n</skills_instructions>\n\n<available_skills>\n\n</available_skills>\n",
			"parameters": {
				"type": "object",
				"properties": {
					"skill": {
						"type": "string",
						"description": "The skill name (no arguments). E.g., \"pdf\" or \"xlsx\""
					}
				},
				"required": [
					"skill"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.SlashCommand",
			"sourcePath": "implementations/tools/defs_cc/017_SlashCommand.yaml",
			"name": "SlashCommand",
			"description": "Execute a slash command within the main conversation\n\nHow slash commands work:\nWhen you use this tool or when a user types a slash command, you will see <command-message>{name} is running…</command-message> followed by the expanded prompt. For example, if .claude/commands/foo.md contains \"Print today's date\", then /foo expands to that prompt in the next message.\n\nUsage:\n- `command` (required): The slash command to execute, including any arguments\n- Example: `command: \"/review-pr 123\"`\n\nIMPORTANT: Only use this tool for custom slash commands that appear in the Available Commands list below. Do NOT use for:\n- Built-in CLI commands (like /help, /clear, etc.)\n- Commands not shown in the list\n- Commands you think might exist but aren't listed\n\nNotes:\n- When a user requests multiple slash commands, execute each one sequentially and check for <command-message>{name} is running…</command-message> to verify each has been processed\n- Do not invoke a command that is already running. For example, if you see <command-message>foo is running…</command-message>, do NOT use this tool with \"/foo\" - process the expanded prompt in the following message\n- Only custom slash commands with descriptions are listed in Available Commands. If a user's command is not listed, ask them to check the slash command file and consult the docs.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"type": "string",
						"description": "The slash command to execute with its arguments, e.g., \"/review-pr 123\""
					}
				},
				"required": [
					"command"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Task",
			"sourcePath": "implementations/tools/defs_cc/001_Task.yaml",
			"name": "Task",
			"description": "Launch a new agent to handle complex, multi-step tasks autonomously. \n\nThe Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types and the tools they have access to:\n\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n\nUsage notes:\n- Always include a short description (3-5 words) summarizing what the agent will do\n- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will need to use TaskOutput to retrieve its results once it's done. You can continue to work while background agents run - When you need their results to continue you can use TaskOutput in blocking mode to pause and wait for their results.\n- Agents can be resumed using the `resume` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.\n- When the agent is done, it will return a single message back to you along with its agent ID. You can use this ID to resume the agent later if needed for follow-up work.\n- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.\n- Agents with \"access to current context\" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., \"investigate the error discussed above\") instead of repeating information. The agent will receive all prior messages and understand the context.\n- The agent's outputs should generally be trusted\n- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n- If the user specifies that they want you to run agents \"in parallel\", you MUST send a single message with multiple Task tool use content blocks. For example, if you need to launch both a code-reviewer agent and a test-runner agent in parallel, send a single message with both tool calls.\n\nExample usage:\n\n<example_agent_descriptions>\n\"code-reviewer\": use this agent after you are done writing a signficant piece of code\n\"greeting-responder\": use this agent when to respond to user greetings with a friendly joke\n</example_agent_description>\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the Write tool to write a function that checks if a number is prime\nassistant: I'm going to use the Write tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a signficant piece of code was written and the task was completed, now use the code-reviewer agent to review the code\n</commentary>\nassistant: Now let me use the code-reviewer agent to review the code\nassistant: Uses the Task tool to launch the code-reviewer agent \n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: \"I'm going to use the Task tool to launch the greeting-responder agent\"\n</example>\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string",
						"description": "A short (3-5 word) description of the task"
					},
					"prompt": {
						"type": "string",
						"description": "The task for the agent to perform"
					},
					"subagent_type": {
						"type": "string",
						"description": "The type of specialized agent to use for this task"
					},
					"model": {
						"type": "string",
						"description": "Optional model to use for this agent. If not specified, inherits from parent. Prefer haiku for quick, straightforward tasks to minimize cost and latency."
					},
					"resume": {
						"type": "string",
						"description": "Optional agent ID to resume from. If provided, the agent will continue from the previous execution transcript."
					},
					"run_in_background": {
						"type": "boolean",
						"description": "Set to true to run this agent in the background. Use TaskOutput to read the output later."
					},
					"parent_task_id": {
						"type": "string",
						"description": "Optional parent task id for C-Tree lineage tracking."
					},
					"tree_path": {
						"type": "string",
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization."
					},
					"depth": {
						"type": "integer",
						"description": "Optional C-Tree depth indicator."
					},
					"priority": {
						"type": "string",
						"description": "Optional C-Tree priority marker (string or numeric encoded)."
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.TaskOutput",
			"sourcePath": "implementations/tools/defs_cc/002_TaskOutput.yaml",
			"name": "TaskOutput",
			"description": "- Retrieves output from a running or completed task (background shell, agent, or remote session)\n- Takes a task_id parameter identifying the task\n- Returns the task output along with status information\n- Use block=true (default) to wait for task completion\n- Use block=false for non-blocking check of current status\n- Task IDs can be found using the /tasks command\n- Works with all task types: background shells, async agents, and remote sessions",
			"parameters": {
				"type": "object",
				"properties": {
					"task_id": {
						"type": "string",
						"description": "The task ID to get output from"
					},
					"block": {
						"type": "boolean",
						"description": "Whether to wait for completion",
						"default": true
					},
					"timeout": {
						"type": "number",
						"description": "Max wait time in ms",
						"default": 30000,
						"maximum": 600000,
						"minimum": 0
					}
				},
				"required": [
					"task_id"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.TodoWrite",
			"sourcePath": "implementations/tools/defs_cc/012_TodoWrite.yaml",
			"name": "TodoWrite",
			"description": "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos\n6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time\n7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Creating dark mode toggle component in Settings page\n2. Adding dark mode state management (context/store)\n3. Implementing CSS-in-JS styles for dark theme\n4. Updating existing components to support theme switching\n5. Running tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implementing memoization for expensive calculations in ProductList, 2) Adding virtualization for long lists in Dashboard, 3) Optimizing image loading in Gallery component, 4) Fixing state update loops in ShoppingCart, 5) Reviewing bundle size and implementing code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n<example>\nUser: Can you add a comment to the calculateTotal function to explain what it does?\nAssistant: Sure, let me add a comment to the calculateTotal function to explain what it does.\n* Uses the Edit tool to add a comment to the calculateTotal function *\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.\n</reasoning>\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n\n   **IMPORTANT**: Task descriptions must have two forms:\n   - content: The imperative form describing what needs to be done (e.g., \"Run tests\", \"Build the project\")\n   - activeForm: The present continuous form shown during execution (e.g., \"Running tests\", \"Building the project\")\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Exactly ONE task must be in_progress at any time (not less, not more)\n   - Complete current tasks before starting new ones\n   - Remove tasks that are no longer relevant from the list entirely\n\n3. **Task Completion Requirements**:\n   - ONLY mark a task as completed when you have FULLY accomplished it\n   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n   - When blocked, create a new task describing what needs to be resolved\n   - Never mark a task as completed if:\n     - Tests are failing\n     - Implementation is partial\n     - You encountered unresolved errors\n     - You couldn't find necessary files or dependencies\n\n4. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n   - Always provide both forms:\n     - content: \"Fix authentication bug\"\n     - activeForm: \"Fixing authentication bug\"\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"todos": {
						"type": "array",
						"description": "The updated todo list",
						"items": {
							"type": "string"
						}
					}
				},
				"required": [
					"todos"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": false
		},
		{
			"id": "cc.WebFetch",
			"sourcePath": "implementations/tools/defs_cc/011_WebFetch.yaml",
			"name": "WebFetch",
			"description": "\n- Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL\n  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"url": {
						"type": "string",
						"description": "The URL to fetch content from",
						"format": "uri"
					},
					"prompt": {
						"type": "string",
						"description": "The prompt to run on the fetched content"
					}
				},
				"required": [
					"url",
					"prompt"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.WebSearch",
			"sourcePath": "implementations/tools/defs_cc/013_WebSearch.yaml",
			"name": "WebSearch",
			"description": "\n- Allows Claude to search the web and use the results to inform responses\n- Provides up-to-date information for current events and recent data\n- Returns search result information formatted as search result blocks, including links as markdown hyperlinks\n- Use this tool for accessing information beyond Claude's knowledge cutoff\n- Searches are performed automatically within a single API call\n\nCRITICAL REQUIREMENT - You MUST follow this:\n  - After answering the user's question, you MUST include a \"Sources:\" section at the end of your response\n  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)\n  - This is MANDATORY - never skip including sources in your response\n  - Example format:\n\n    [Your answer here]\n\n    Sources:\n    - [Source Title 1](https://example.com/1)\n    - [Source Title 2](https://example.com/2)\n\nUsage notes:\n  - Domain filtering is supported to include or block specific websites\n  - Web search is only available in the US\n\nIMPORTANT - Use the correct year in search queries:\n  - Today's date is 2025-12-18. You MUST use this year when searching for recent information, documentation, or current events.\n  - Example: If today is 2025-07-15 and the user asks for \"latest React docs\", search for \"React documentation 2025\", NOT \"React documentation 2024\"\n",
			"parameters": {
				"type": "object",
				"properties": {
					"query": {
						"type": "string",
						"description": "The search query to use",
						"minLength": 2
					},
					"allowed_domains": {
						"type": "array",
						"description": "Only include search results from these domains",
						"items": {
							"type": "string"
						}
					},
					"blocked_domains": {
						"type": "array",
						"description": "Never include search results from these domains",
						"items": {
							"type": "string"
						}
					}
				},
				"required": [
					"query"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		},
		{
			"id": "cc.Write",
			"sourcePath": "implementations/tools/defs_cc/009_Write.yaml",
			"name": "Write",
			"description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
			"parameters": {
				"type": "object",
				"properties": {
					"file_path": {
						"type": "string",
						"description": "The absolute path to the file to write (must be absolute, not relative)"
					},
					"content": {
						"type": "string",
						"description": "The content to write to the file"
					}
				},
				"required": [
					"file_path",
					"content"
				],
				"additionalProperties": false,
				"$schema": "http://json-schema.org/draft-07/schema#"
			},
			"nativePrimary": true
		}
	],
	"implementations/tools/defs": [
		{
			"id": "background_cancel",
			"sourcePath": "implementations/tools/defs/opencode_background_cancel.yaml",
			"name": "background_cancel",
			"description": "Cancel running background task(s). Use all=true to cancel ALL before final answer.",
			"parameters": {
				"type": "object",
				"properties": {
					"all": {
						"type": "boolean",
						"description": "Cancel all running background tasks (default: false)"
					},
					"taskId": {
						"type": "string",
						"description": "Task ID to cancel (required if all=false)"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "background_output",
			"sourcePath": "implementations/tools/defs/opencode_background_output.yaml",
			"name": "background_output",
			"description": "Get output from background task. System notifies on completion, so block=true rarely needed.",
			"parameters": {
				"type": "object",
				"properties": {
					"block": {
						"type": "boolean",
						"description": "If true, wait until the task finishes"
					},
					"task_id": {
						"type": "string",
						"description": "The background task id returned by background_task"
					},
					"timeout": {
						"type": "number",
						"description": "Max wait time in ms (default: 60000, max: 600000)"
					}
				},
				"required": [
					"task_id"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "background_task",
			"sourcePath": "implementations/tools/defs/opencode_background_task.yaml",
			"name": "background_task",
			"description": "Run agent task in background. Returns task_id immediately; notifies on completion.\n\nUse `background_output` to get results. Prompts MUST be in English.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"agent": {
						"type": "string",
						"description": "Agent type to use (any registered agent)"
					},
					"depth": {
						"type": "integer",
						"description": "Optional C-Tree depth indicator."
					},
					"description": {
						"type": "string",
						"description": "Short task description (shown in status)"
					},
					"parent_task_id": {
						"type": "string",
						"description": "Optional parent task id for C-Tree lineage tracking."
					},
					"priority": {
						"type": "string",
						"description": "Optional C-Tree priority marker (string or numeric encoded)."
					},
					"prompt": {
						"type": "string",
						"description": "Full detailed prompt for the agent"
					},
					"tree_path": {
						"type": "string",
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization."
					}
				},
				"required": [
					"agent",
					"description",
					"prompt"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "bash",
			"sourcePath": "implementations/tools/defs/opencode_bash.yaml",
			"name": "bash",
			"description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nAll commands run in /shared_folders/querylake_server/ray_testing/ray_SCE/misc/opencode_runs/goldens/1.0.193/phase8_async_subagents_live_check_v2/runs/20251226_210501/workspace by default. Use the `workdir` parameter if you need to run a command in a different directory.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use the List tool to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use List to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n    - The command argument is required.\n    - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes).\n  If not specified, commands will timeout after 120000ms (2 minutes).\n    - The description argument is required. You must write a clear, concise description of what this command does in 5-10 words.\n    - If the output exceeds 30000 characters, output will be truncated before being\n  returned to you.\n    - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or\n  `echo` commands, unless explicitly instructed or when these commands are truly necessary\n   for the task. Instead, always prefer using the dedicated tools for these commands:\n      - File search: Use Glob (NOT find or ls)\n      - Content search: Use Grep (NOT grep or rg)\n      - Read files: Use Read (NOT cat/head/tail)\n      - Edit files: Use Edit (NOT sed/awk)\n      - Write files: Use Write (NOT echo >/cat <<EOF)\n      - Communication: Output text directly (NOT echo/printf)\n    - When issuing multiple commands:\n      - If the commands are independent and can run in parallel, make multiple Bash tool\n  calls in a single message. For example, if you need to run \"git status\" and \"git diff\",\n  send a single message with two Bash tool calls in parallel.\n      - If the commands depend on each other and must run sequentially, use a single Bash\n  call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" &&\n  git push`). For instance, if one operation must complete before another starts (like\n  mkdir before cp, Write before Bash for git operations, or git add before git commit),\n  run these operations sequentially instead.\n      - Use ';' only when you need to run commands sequentially but don't care if earlier\n  commands fail\n      - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n    - Try to maintain your current working directory throughout the session by using\n  absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly\n  requests it.\n      <good-example>\n      pytest /foo/bar/tests\n      </good-example>\n      <bad-example>\n      cd /foo/bar && pytest tests\n      </bad-example>\n\n# Working Directory\n\nThe `workdir` parameter sets the working directory for command execution. Prefer using `workdir` over `cd <dir> &&` command chains when you simply need to run a command in a different directory.\n\n<good-example>\nworkdir=\"/foo/bar\", command=\"pytest tests\"\n</good-example>\n<good-example>\ncommand=\"pytest /foo/bar/tests\"\n</good-example>\n<bad-example>\ncommand=\"cd /foo/bar && pytest tests\"\n</bad-example>\n\n# Committing changes with git\n\nIMPORTANT: ONLY COMMIT IF THE USER ASKS YOU TO.\n\nIf and only if the user asks you to create a new git commit, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel, each using the Bash tool:\n   - Run a git status command to see all untracked files.\n   - Run a git diff command to see both staged and unstaged changes that will be committed.\n   - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message. When analyzing:\n\n- List the files that have been changed or added\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n- Ensure your language is clear, concise, and to the point\n- Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the message is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft message to ensure it accurately reflects the changes and their purpose\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Add relevant untracked files to the staging area.\n   - Run git status to make sure the commit succeeded.\n\n4. If the commit fails due to pre-commit hook changes, retry the commit ONCE to include these automated changes. If it fails again, it usually means a pre-commit hook is preventing the commit. If the commit succeeds but you notice that files were modified by the pre-commit hook, you MUST amend your commit to include them.\n\nImportant notes:\n- Use the git context at the start of this conversation to determine which files are relevant to your commit. Be careful not to stage and commit files (e.g. with `git add .`) that aren't relevant to your commit.\n- NEVER update the git config\n- DO NOT run additional commands to read or explore code, beyond what is available in the git context\n- DO NOT push to the remote repository\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- Ensure your commit message is meaningful and concise. It should explain the purpose of the changes, not just describe them.\n- Return an empty response - the user will see the git output directly\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff main...HEAD` to understand the full commit history for the current branch (from the time it diverged from the `main` branch)\n\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary. Wrap your analysis process in <pr_analysis> tags:\n\n<pr_analysis>\n- List the commits since diverging from the main branch\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Do not use tools to explore code, beyond what is available in the git context\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 bullet points) pull request summary that focuses on the \"why\" rather than the \"what\"\n- Ensure the summary accurately reflects all changes since diverging from the main branch\n- Ensure your language is clear, concise, and to the point\n- Ensure the summary accurately reflects the changes and their purpose (ie. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the summary is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft summary to ensure it accurately reflects the changes and their purpose\n</pr_analysis>\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\nEOF\n)\"\n</example>\n\nImportant:\n- NEVER update the git config\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"description": "The command to execute",
						"type": "string"
					},
					"description": {
						"description": "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
						"type": "string"
					},
					"timeout": {
						"description": "Optional timeout in milliseconds",
						"type": "number"
					},
					"workdir": {
						"description": "The working directory to run the command in. Defaults to /shared_folders/querylake_server/ray_testing/ray_SCE/misc/opencode_runs/goldens/1.0.193/phase8_async_subagents_live_check_v2/runs/20251226_210501/workspace. Use this instead of 'cd' commands.",
						"type": "string"
					}
				},
				"required": [
					"command",
					"description"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true,
			"maxPerTurn": 1
		},
		{
			"id": "call_omo_agent",
			"sourcePath": "implementations/tools/defs/opencode_call_omo_agent.yaml",
			"name": "call_omo_agent",
			"description": "Spawn explore/librarian agent. run_in_background REQUIRED (true=async with task_id, false=sync).\n\nAvailable:\n- explore: Specialized agent for explore tasks\n- librarian: Specialized agent for librarian tasks\n\nPrompts MUST be in English. Use `background_output` for async results.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string",
						"description": "A short (3-5 words) description of the task"
					},
					"prompt": {
						"type": "string",
						"description": "The task for the agent to perform"
					},
					"run_in_background": {
						"type": "boolean",
						"description": "REQUIRED. true: run asynchronously (use background_output to get results), false: run synchronously and wait for completion"
					},
					"session_id": {
						"type": "string",
						"description": "Existing Task session to continue"
					},
					"subagent_type": {
						"type": "string",
						"description": "The type of specialized agent to use for this task (explore or librarian only)"
					}
				},
				"required": [
					"description",
					"prompt",
					"run_in_background",
					"subagent_type"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "edit",
			"sourcePath": "implementations/tools/defs/opencode_edit.yaml",
			"name": "edit",
			"description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"oldString found multiple times and requires more code context to uniquely identify the intended match\". Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The absolute path to the file to modify",
						"type": "string"
					},
					"newString": {
						"description": "The text to replace it with (must be different from oldString)",
						"type": "string"
					},
					"oldString": {
						"description": "The text to replace",
						"type": "string"
					},
					"replaceAll": {
						"description": "Replace all occurrences of oldString (default false)",
						"type": "boolean"
					}
				},
				"required": [
					"filePath",
					"newString",
					"oldString"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "glob",
			"sourcePath": "implementations/tools/defs/opencode_glob.yaml",
			"name": "glob",
			"description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"path": {
						"description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
						"type": "string"
					},
					"pattern": {
						"description": "The glob pattern to match files against",
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "grep",
			"sourcePath": "implementations/tools/defs/opencode_grep.yaml",
			"name": "grep",
			"description": "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with at least one match sorted by modification time\n- Use this tool when you need to find files containing specific patterns\n- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n",
			"parameters": {
				"type": "object",
				"properties": {
					"include": {
						"description": "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")",
						"type": "string"
					},
					"path": {
						"description": "The directory to search in. Defaults to the current working directory.",
						"type": "string"
					},
					"pattern": {
						"description": "The regex pattern to search for in file contents",
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "invalid",
			"sourcePath": "implementations/tools/defs/opencode_invalid.yaml",
			"name": "invalid",
			"description": "Invalid tool (OpenCode-compatible)",
			"parameters": {
				"type": "object",
				"properties": {
					"error": {
						"type": "string",
						"description": "The validation error message"
					},
					"tool": {
						"type": "string",
						"description": "The tool name that was invalid"
					}
				},
				"required": [
					"error",
					"tool"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "list",
			"sourcePath": "implementations/tools/defs/opencode_list.yaml",
			"name": "list",
			"description": "Lists files and directories in a given path. The path parameter must be absolute; omit it to use the current workspace directory. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"ignore": {
						"description": "List of glob patterns to ignore",
						"type": "array",
						"items": {
							"type": "string"
						}
					},
					"path": {
						"description": "The absolute path to the directory to list (must be absolute, not relative)",
						"type": "string"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "lsp-diagnostics",
			"sourcePath": "implementations/tools/defs/opencode_ls_diagnostics.yaml",
			"name": "lsp-diagnostics",
			"description": "Return diagnostics from LSP server (OpenCode-compatible)",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "patch",
			"sourcePath": "implementations/tools/defs/opencode_patch.yaml",
			"name": "patch",
			"description": "Apply an OpenCode patch block (*** Begin Patch / *** Update|Add|Delete File / *** End Patch)",
			"parameters": {
				"type": "object",
				"properties": {
					"patchText": {
						"type": "string",
						"description": "The full patch text that describes all changes to be made"
					}
				},
				"required": [
					"patchText"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "read",
			"sourcePath": "implementations/tools/defs/opencode_read.yaml",
			"name": "read",
			"description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The filePath parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.\n- You can read image files using this tool.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The path to the file to read",
						"type": "string"
					},
					"limit": {
						"description": "The number of lines to read (defaults to 2000)",
						"type": "number"
					},
					"offset": {
						"description": "The line number to start reading from (0-based)",
						"type": "number"
					}
				},
				"required": [
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "skill",
			"sourcePath": "implementations/tools/defs/opencode_skill.yaml",
			"name": "skill",
			"description": "Load a skill to get detailed instructions for a specific task. Skills provide specialized knowledge and step-by-step guidance. Use this when a task matches an available skill's description. <available_skills> </available_skills>",
			"parameters": {
				"type": "object",
				"properties": {
					"name": {
						"description": "The skill identifier from available_skills (e.g., 'code-review')",
						"type": "string"
					}
				},
				"required": [
					"name"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "task",
			"sourcePath": "implementations/tools/defs/opencode_task.yaml",
			"name": "task",
			"description": "Launch a new agent to handle complex, multi-step tasks autonomously.\n\nAvailable agent types and the tools they have access to:\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- grep-summarizer: Read-only grep specialist (search for strings and report matches).\n- repo-scanner: Read-only repo scanner (list structure, summarize layout).\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen to use the Task tool:\n- When you are instructed to execute custom slash commands. Use the Task tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description=\"Check the file\", prompt=\"/check-file path/to/file.py\")\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n3. Each agent invocation is stateless unless you provide a session_id. Your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n4. The agent's outputs should generally be trusted\n5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nExample usage (NOTE: The agents below are fictional examples for illustration only - use the actual agents listed above):\n\n<example_agent_descriptions>\n\"code-reviewer\": use this agent after you are done writing a significant piece of code\n\"greeting-responder\": use this agent when to respond to user greetings with a friendly joke\n</example_agent_description>\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the Write tool to write a function that checks if a number is prime\nassistant: I'm going to use the Write tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code\n</commentary>\nassistant: Now let me use the code-reviewer agent to review the code\nassistant: Uses the Task tool to launch the code-reviewer agent\n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: \"I'm going to use the Task tool to launch the with the greeting-responder agent\"\n</example>\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"description": "The command that triggered this task",
						"type": "string"
					},
					"depth": {
						"description": "Optional C-Tree depth indicator.",
						"type": "integer"
					},
					"description": {
						"description": "A short (3-5 words) description of the task",
						"type": "string"
					},
					"parent_task_id": {
						"description": "Optional parent task id for C-Tree lineage tracking.",
						"type": "string"
					},
					"priority": {
						"description": "Optional C-Tree priority marker (string or numeric encoded).",
						"type": "string"
					},
					"prompt": {
						"description": "The task for the agent to perform",
						"type": "string"
					},
					"run_in_background": {
						"description": "Run the delegated task asynchronously and return immediately with a task id when supported.",
						"type": "boolean"
					},
					"session_id": {
						"description": "Existing Task session to continue",
						"type": "string"
					},
					"subagent_type": {
						"description": "The type of specialized agent to use for this task",
						"type": "string"
					},
					"tree_path": {
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization.",
						"type": "string"
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "todoread",
			"sourcePath": "implementations/tools/defs/opencode_todoread.yaml",
			"name": "todoread",
			"description": "Use this tool to read your todo list",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "todowrite",
			"sourcePath": "implementations/tools/defs/opencode_todowrite.yaml",
			"name": "todowrite",
			"description": "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos. Feel free to edit the todo list based on new information.\n6. After completing a task - Mark it complete and add any new follow-up tasks\n7. When you start working on a new task, mark the todo as in_progress. Ideally you should only have one todo as in_progress at a time. Complete existing tasks before starting new ones.\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Create dark mode toggle component in Settings page\n2. Add dark mode state management (context/store)\n3. Implement CSS-in-JS styles for dark theme\n4. Update existing components to support theme switching\n5. Run tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implement memoization for expensive calculations in ProductList, 2) Add virtualization for long lists in Dashboard, 3) Optimize image loading in Gallery component, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and implement code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n<example>\nUser: Can you add a comment to the calculateTotal function to explain what it does?\nAssistant: Sure, let me add a comment to the calculateTotal function to explain what it does.\n* Uses the Edit tool to add a comment to the calculateTotal function *\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.\n</reasoning>\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n   - cancelled: Task no longer needed\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Only have ONE task in_progress at any time\n   - Complete current tasks before starting new ones\n   - Cancel tasks that become irrelevant\n\n3. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n\n",
			"parameters": {
				"type": "object",
				"properties": {
					"todos": {
						"description": "The updated todo list",
						"type": "array",
						"items": {
							"type": "object",
							"properties": {
								"content": {
									"description": "Brief description of the task",
									"type": "string"
								},
								"status": {
									"description": "Current status of the task: pending, in_progress, completed, cancelled",
									"type": "string"
								},
								"priority": {
									"description": "Priority level of the task: high, medium, low",
									"type": "string"
								},
								"id": {
									"description": "Unique identifier for the todo item",
									"type": "string"
								}
							},
							"required": [
								"content",
								"status",
								"priority",
								"id"
							],
							"additionalProperties": false
						}
					}
				},
				"required": [
					"todos"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "webfetch",
			"sourcePath": "implementations/tools/defs/opencode_webfetch.yaml",
			"name": "webfetch",
			"description": "- Fetches content from a specified URL\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
			"parameters": {
				"type": "object",
				"properties": {
					"format": {
						"description": "The format to return the content in (text, markdown, or html)",
						"type": "string",
						"enum": [
							"text",
							"markdown",
							"html"
						]
					},
					"timeout": {
						"description": "Optional timeout in seconds (max 120)",
						"type": "number"
					},
					"url": {
						"description": "The URL to fetch content from",
						"type": "string"
					}
				},
				"required": [
					"format",
					"url"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "write",
			"sourcePath": "implementations/tools/defs/opencode_write.yaml",
			"name": "write",
			"description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"description": "The content to write to the file",
						"type": "string"
					},
					"filePath": {
						"description": "The absolute path to the file to write (must be absolute, not relative)",
						"type": "string"
					}
				},
				"required": [
					"content",
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		}
	],
	"implementations/tools/defs_oc": [
		{
			"id": "background_cancel",
			"sourcePath": "implementations/tools/defs_oc/opencode_background_cancel.yaml",
			"name": "background_cancel",
			"description": "Cancel running background task(s). Use all=true to cancel ALL before final answer.",
			"parameters": {
				"type": "object",
				"properties": {
					"taskId": {
						"type": "string",
						"description": "Task ID to cancel (required if all=false)"
					},
					"all": {
						"type": "boolean",
						"description": "Cancel all running background tasks (default: false)"
					}
				},
				"required": []
			},
			"nativePrimary": true
		},
		{
			"id": "background_output",
			"sourcePath": "implementations/tools/defs_oc/opencode_background_output.yaml",
			"name": "background_output",
			"description": "Get output from background task. System notifies on completion, so block=true rarely needed.",
			"parameters": {
				"type": "object",
				"properties": {
					"task_id": {
						"type": "string",
						"description": "The background task id returned by background_task"
					},
					"block": {
						"type": "boolean",
						"description": "If true, wait until the task finishes"
					},
					"timeout": {
						"type": "number",
						"description": "Max wait time in ms (default: 60000, max: 600000)"
					}
				},
				"required": [
					"task_id"
				]
			},
			"nativePrimary": true
		},
		{
			"id": "background_task",
			"sourcePath": "implementations/tools/defs_oc/opencode_background_task.yaml",
			"name": "background_task",
			"description": "Run agent task in background. Returns task_id immediately; notifies on completion.\n\nUse `background_output` to get results. Prompts MUST be in English.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string",
						"description": "Short task description (shown in status)"
					},
					"prompt": {
						"type": "string",
						"description": "Full detailed prompt for the agent"
					},
					"agent": {
						"type": "string",
						"description": "Agent type to use (any registered agent)"
					},
					"parent_task_id": {
						"type": "string",
						"description": "Optional parent task id for C-Tree lineage tracking."
					},
					"tree_path": {
						"type": "string",
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization."
					},
					"depth": {
						"type": "integer",
						"description": "Optional C-Tree depth indicator."
					},
					"priority": {
						"type": "string",
						"description": "Optional C-Tree priority marker (string or numeric encoded)."
					}
				},
				"required": [
					"description",
					"prompt",
					"agent"
				]
			},
			"nativePrimary": true
		},
		{
			"id": "bash",
			"sourcePath": "implementations/tools/defs_oc/opencode_bash.yaml",
			"name": "bash",
			"description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nAll commands run in /shared_folders/querylake_server/ray_testing/ray_SCE/misc/opencode_runs/goldens/1.0.193/phase8_async_subagents_live_check_v2/runs/20251226_210501/workspace by default. Use the `workdir` parameter if you need to run a command in a different directory.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use the List tool to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use List to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n    - The command argument is required.\n    - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes).\n  If not specified, commands will timeout after 120000ms (2 minutes).\n    - The description argument is required. You must write a clear, concise description of what this command does in 5-10 words.\n    - If the output exceeds 30000 characters, output will be truncated before being\n  returned to you.\n    - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or\n  `echo` commands, unless explicitly instructed or when these commands are truly necessary\n   for the task. Instead, always prefer using the dedicated tools for these commands:\n      - File search: Use Glob (NOT find or ls)\n      - Content search: Use Grep (NOT grep or rg)\n      - Read files: Use Read (NOT cat/head/tail)\n      - Edit files: Use Edit (NOT sed/awk)\n      - Write files: Use Write (NOT echo >/cat <<EOF)\n      - Communication: Output text directly (NOT echo/printf)\n    - When issuing multiple commands:\n      - If the commands are independent and can run in parallel, make multiple Bash tool\n  calls in a single message. For example, if you need to run \"git status\" and \"git diff\",\n  send a single message with two Bash tool calls in parallel.\n      - If the commands depend on each other and must run sequentially, use a single Bash\n  call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" &&\n  git push`). For instance, if one operation must complete before another starts (like\n  mkdir before cp, Write before Bash for git operations, or git add before git commit),\n  run these operations sequentially instead.\n      - Use ';' only when you need to run commands sequentially but don't care if earlier\n  commands fail\n      - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n    - Try to maintain your current working directory throughout the session by using\n  absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly\n  requests it.\n      <good-example>\n      pytest /foo/bar/tests\n      </good-example>\n      <bad-example>\n      cd /foo/bar && pytest tests\n      </bad-example>\n\n# Working Directory\n\nThe `workdir` parameter sets the working directory for command execution. Prefer using `workdir` over `cd <dir> &&` command chains when you simply need to run a command in a different directory.\n\n<good-example>\nworkdir=\"/foo/bar\", command=\"pytest tests\"\n</good-example>\n<good-example>\ncommand=\"pytest /foo/bar/tests\"\n</good-example>\n<bad-example>\ncommand=\"cd /foo/bar && pytest tests\"\n</bad-example>\n\n# Committing changes with git\n\nIMPORTANT: ONLY COMMIT IF THE USER ASKS YOU TO.\n\nIf and only if the user asks you to create a new git commit, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel, each using the Bash tool:\n   - Run a git status command to see all untracked files.\n   - Run a git diff command to see both staged and unstaged changes that will be committed.\n   - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message. When analyzing:\n\n- List the files that have been changed or added\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n- Ensure your language is clear, concise, and to the point\n- Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the message is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft message to ensure it accurately reflects the changes and their purpose\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Add relevant untracked files to the staging area.\n   - Run git status to make sure the commit succeeded.\n\n4. If the commit fails due to pre-commit hook changes, retry the commit ONCE to include these automated changes. If it fails again, it usually means a pre-commit hook is preventing the commit. If the commit succeeds but you notice that files were modified by the pre-commit hook, you MUST amend your commit to include them.\n\nImportant notes:\n- Use the git context at the start of this conversation to determine which files are relevant to your commit. Be careful not to stage and commit files (e.g. with `git add .`) that aren't relevant to your commit.\n- NEVER update the git config\n- DO NOT run additional commands to read or explore code, beyond what is available in the git context\n- DO NOT push to the remote repository\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- Ensure your commit message is meaningful and concise. It should explain the purpose of the changes, not just describe them.\n- Return an empty response - the user will see the git output directly\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff main...HEAD` to understand the full commit history for the current branch (from the time it diverged from the `main` branch)\n\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary. Wrap your analysis process in <pr_analysis> tags:\n\n<pr_analysis>\n- List the commits since diverging from the main branch\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Do not use tools to explore code, beyond what is available in the git context\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 bullet points) pull request summary that focuses on the \"why\" rather than the \"what\"\n- Ensure the summary accurately reflects all changes since diverging from the main branch\n- Ensure your language is clear, concise, and to the point\n- Ensure the summary accurately reflects the changes and their purpose (ie. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the summary is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft summary to ensure it accurately reflects the changes and their purpose\n</pr_analysis>\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\nEOF\n)\"\n</example>\n\nImportant:\n- NEVER update the git config\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"description": "The command to execute",
						"type": "string"
					},
					"timeout": {
						"description": "Optional timeout in milliseconds",
						"type": "number"
					},
					"workdir": {
						"description": "The working directory to run the command in. Defaults to /shared_folders/querylake_server/ray_testing/ray_SCE/misc/opencode_runs/goldens/1.0.193/phase8_async_subagents_live_check_v2/runs/20251226_210501/workspace. Use this instead of 'cd' commands.",
						"type": "string"
					},
					"description": {
						"description": "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
						"type": "string"
					}
				},
				"required": [
					"command",
					"description"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true,
			"maxPerTurn": 1
		},
		{
			"id": "call_omo_agent",
			"sourcePath": "implementations/tools/defs_oc/opencode_call_omo_agent.yaml",
			"name": "call_omo_agent",
			"description": "Spawn explore/librarian agent. run_in_background REQUIRED (true=async with task_id, false=sync).\n\nAvailable:\n- explore: Specialized agent for explore tasks\n- librarian: Specialized agent for librarian tasks\n\nPrompts MUST be in English. Use `background_output` for async results.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string",
						"description": "A short (3-5 words) description of the task"
					},
					"prompt": {
						"type": "string",
						"description": "The task for the agent to perform"
					},
					"subagent_type": {
						"type": "string",
						"description": "The type of specialized agent to use for this task (explore or librarian only)"
					},
					"run_in_background": {
						"type": "boolean",
						"description": "REQUIRED. true: run asynchronously (use background_output to get results), false: run synchronously and wait for completion"
					},
					"session_id": {
						"type": "string",
						"description": "Existing Task session to continue"
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type",
					"run_in_background"
				]
			},
			"nativePrimary": true
		},
		{
			"id": "edit",
			"sourcePath": "implementations/tools/defs_oc/opencode_edit.yaml",
			"name": "edit",
			"description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"oldString found multiple times and requires more code context to uniquely identify the intended match\". Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The absolute path to the file to modify",
						"type": "string"
					},
					"oldString": {
						"description": "The text to replace",
						"type": "string"
					},
					"newString": {
						"description": "The text to replace it with (must be different from oldString)",
						"type": "string"
					},
					"replaceAll": {
						"description": "Replace all occurrences of oldString (default false)",
						"type": "boolean"
					}
				},
				"required": [
					"filePath",
					"oldString",
					"newString"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "glob",
			"sourcePath": "implementations/tools/defs_oc/opencode_glob.yaml",
			"name": "glob",
			"description": "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"description": "The glob pattern to match files against",
						"type": "string"
					},
					"path": {
						"description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "grep",
			"sourcePath": "implementations/tools/defs_oc/opencode_grep.yaml",
			"name": "grep",
			"description": "- Fast content search tool that works with any codebase size\n- Searches file contents using regular expressions\n- Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.)\n- Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\")\n- Returns file paths and line numbers with at least one match sorted by modification time\n- Use this tool when you need to find files containing specific patterns\n- If you need to identify/count the number of matches within files, use the Bash tool with `rg` (ripgrep) directly. Do NOT use `grep`.\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Task tool instead\n",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"description": "The regex pattern to search for in file contents",
						"type": "string"
					},
					"path": {
						"description": "The directory to search in. Defaults to the current working directory.",
						"type": "string"
					},
					"include": {
						"description": "File pattern to include in the search (e.g. \"*.js\", \"*.{ts,tsx}\")",
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "invalid",
			"sourcePath": "implementations/tools/defs_oc/opencode_invalid.yaml",
			"name": "invalid",
			"description": "Invalid tool (OpenCode-compatible)",
			"parameters": {
				"type": "object",
				"properties": {
					"tool": {
						"type": "string",
						"description": "The tool name that was invalid"
					},
					"error": {
						"type": "string",
						"description": "The validation error message"
					}
				},
				"required": [
					"tool",
					"error"
				]
			},
			"nativePrimary": true
		},
		{
			"id": "list",
			"sourcePath": "implementations/tools/defs_oc/opencode_list.yaml",
			"name": "list",
			"description": "Lists files and directories in a given path. The path parameter must be absolute; omit it to use the current workspace directory. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"path": {
						"description": "The absolute path to the directory to list (must be absolute, not relative)",
						"type": "string"
					},
					"ignore": {
						"description": "List of glob patterns to ignore",
						"type": "array",
						"items": {
							"type": "string"
						}
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp-diagnostics",
			"sourcePath": "implementations/tools/defs_oc/opencode_ls_diagnostics.yaml",
			"name": "lsp-diagnostics",
			"description": "Return diagnostics from LSP server (OpenCode-compatible)",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": []
			},
			"nativePrimary": true
		},
		{
			"id": "patch",
			"sourcePath": "implementations/tools/defs_oc/opencode_patch.yaml",
			"name": "patch",
			"description": "Apply an OpenCode patch block (*** Begin Patch / *** Update|Add|Delete File / *** End Patch)",
			"parameters": {
				"type": "object",
				"properties": {
					"patchText": {
						"type": "string",
						"description": "The full patch text that describes all changes to be made"
					}
				},
				"required": [
					"patchText"
				]
			},
			"nativePrimary": true
		},
		{
			"id": "read",
			"sourcePath": "implementations/tools/defs_oc/opencode_read.yaml",
			"name": "read",
			"description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The filePath parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.\n- You can read image files using this tool.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The path to the file to read",
						"type": "string"
					},
					"offset": {
						"description": "The line number to start reading from (0-based)",
						"type": "number"
					},
					"limit": {
						"description": "The number of lines to read (defaults to 2000)",
						"type": "number"
					}
				},
				"required": [
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "skill",
			"sourcePath": "implementations/tools/defs_oc/opencode_skill.yaml",
			"name": "skill",
			"description": "Load a skill to get detailed instructions for a specific task. Skills provide specialized knowledge and step-by-step guidance. Use this when a task matches an available skill's description. <available_skills> </available_skills>",
			"parameters": {
				"type": "object",
				"properties": {
					"name": {
						"description": "The skill identifier from available_skills (e.g., 'code-review')",
						"type": "string"
					}
				},
				"required": [
					"name"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "task",
			"sourcePath": "implementations/tools/defs_oc/opencode_task.yaml",
			"name": "task",
			"description": "Launch a new agent to handle complex, multi-step tasks autonomously.\n\nAvailable agent types and the tools they have access to:\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- grep-summarizer: Read-only grep specialist (search for strings and report matches).\n- repo-scanner: Read-only repo scanner (list structure, summarize layout).\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen to use the Task tool:\n- When you are instructed to execute custom slash commands. Use the Task tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description=\"Check the file\", prompt=\"/check-file path/to/file.py\")\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n3. Each agent invocation is stateless unless you provide a session_id. Your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n4. The agent's outputs should generally be trusted\n5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nExample usage (NOTE: The agents below are fictional examples for illustration only - use the actual agents listed above):\n\n<example_agent_descriptions>\n\"code-reviewer\": use this agent after you are done writing a significant piece of code\n\"greeting-responder\": use this agent when to respond to user greetings with a friendly joke\n</example_agent_description>\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the Write tool to write a function that checks if a number is prime\nassistant: I'm going to use the Write tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code\n</commentary>\nassistant: Now let me use the code-reviewer agent to review the code\nassistant: Uses the Task tool to launch the code-reviewer agent\n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: \"I'm going to use the Task tool to launch the with the greeting-responder agent\"\n</example>\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"description": "A short (3-5 words) description of the task",
						"type": "string"
					},
					"prompt": {
						"description": "The task for the agent to perform",
						"type": "string"
					},
					"subagent_type": {
						"description": "The type of specialized agent to use for this task",
						"type": "string"
					},
					"session_id": {
						"description": "Existing Task session to continue",
						"type": "string"
					},
					"run_in_background": {
						"description": "Run the delegated task asynchronously and return immediately with a task id when supported.",
						"type": "boolean"
					},
					"command": {
						"description": "The command that triggered this task",
						"type": "string"
					},
					"parent_task_id": {
						"description": "Optional parent task id for C-Tree lineage tracking.",
						"type": "string"
					},
					"tree_path": {
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization.",
						"type": "string"
					},
					"depth": {
						"description": "Optional C-Tree depth indicator.",
						"type": "integer"
					},
					"priority": {
						"description": "Optional C-Tree priority marker (string or numeric encoded).",
						"type": "string"
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "todoread",
			"sourcePath": "implementations/tools/defs_oc/opencode_todoread.yaml",
			"name": "todoread",
			"description": "Use this tool to read your todo list",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "todowrite",
			"sourcePath": "implementations/tools/defs_oc/opencode_todowrite.yaml",
			"name": "todowrite",
			"description": "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos. Feel free to edit the todo list based on new information.\n6. After completing a task - Mark it complete and add any new follow-up tasks\n7. When you start working on a new task, mark the todo as in_progress. Ideally you should only have one todo as in_progress at a time. Complete existing tasks before starting new ones.\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Create dark mode toggle component in Settings page\n2. Add dark mode state management (context/store)\n3. Implement CSS-in-JS styles for dark theme\n4. Update existing components to support theme switching\n5. Run tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implement memoization for expensive calculations in ProductList, 2) Add virtualization for long lists in Dashboard, 3) Optimize image loading in Gallery component, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and implement code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n<example>\nUser: Can you add a comment to the calculateTotal function to explain what it does?\nAssistant: Sure, let me add a comment to the calculateTotal function to explain what it does.\n* Uses the Edit tool to add a comment to the calculateTotal function *\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.\n</reasoning>\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n   - cancelled: Task no longer needed\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Only have ONE task in_progress at any time\n   - Complete current tasks before starting new ones\n   - Cancel tasks that become irrelevant\n\n3. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n\n",
			"parameters": {
				"type": "object",
				"properties": {
					"todos": {
						"description": "The updated todo list",
						"type": "array",
						"items": {
							"type": "object",
							"properties": {
								"content": {
									"description": "Brief description of the task",
									"type": "string"
								},
								"status": {
									"description": "Current status of the task: pending, in_progress, completed, cancelled",
									"type": "string"
								},
								"priority": {
									"description": "Priority level of the task: high, medium, low",
									"type": "string"
								},
								"id": {
									"description": "Unique identifier for the todo item",
									"type": "string"
								}
							},
							"required": [
								"content",
								"status",
								"priority",
								"id"
							],
							"additionalProperties": false
						}
					}
				},
				"required": [
					"todos"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "webfetch",
			"sourcePath": "implementations/tools/defs_oc/opencode_webfetch.yaml",
			"name": "webfetch",
			"description": "- Fetches content from a specified URL\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
			"parameters": {
				"type": "object",
				"properties": {
					"url": {
						"description": "The URL to fetch content from",
						"type": "string"
					},
					"format": {
						"description": "The format to return the content in (text, markdown, or html)",
						"type": "string",
						"enum": [
							"text",
							"markdown",
							"html"
						]
					},
					"timeout": {
						"description": "Optional timeout in seconds (max 120)",
						"type": "number"
					}
				},
				"required": [
					"url",
					"format"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "write",
			"sourcePath": "implementations/tools/defs_oc/opencode_write.yaml",
			"name": "write",
			"description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"description": "The content to write to the file",
						"type": "string"
					},
					"filePath": {
						"description": "The absolute path to the file to write (must be absolute, not relative)",
						"type": "string"
					}
				},
				"required": [
					"content",
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		}
	],
	"implementations/tools/defs_omo": [
		{
			"id": "ast_grep_replace",
			"sourcePath": "implementations/tools/defs_omo/opencode_ast_grep_replace.yaml",
			"name": "ast_grep_replace",
			"description": "Replace code patterns across filesystem with AST-aware rewriting. Dry-run by default. Use meta-variables in rewrite to preserve matched content. Example: pattern='console.log($MSG)' rewrite='logger.info($MSG)'",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string"
					},
					"rewrite": {
						"type": "string"
					},
					"lang": {
						"type": "string",
						"enum": [
							"bash",
							"c",
							"cpp",
							"csharp",
							"css",
							"elixir",
							"go",
							"haskell",
							"html",
							"java",
							"javascript",
							"json",
							"kotlin",
							"lua",
							"nix",
							"php",
							"python",
							"ruby",
							"rust",
							"scala",
							"solidity",
							"swift",
							"typescript",
							"tsx",
							"yaml"
						]
					},
					"paths": {
						"type": "array",
						"items": {
							"type": "string"
						}
					},
					"globs": {
						"type": "array",
						"items": {
							"type": "string"
						}
					},
					"dryRun": {
						"type": "boolean"
					}
				},
				"required": [
					"pattern",
					"rewrite",
					"lang"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "ast_grep_search",
			"sourcePath": "implementations/tools/defs_omo/opencode_ast_grep_search.yaml",
			"name": "ast_grep_search",
			"description": "Search code patterns across filesystem using AST-aware matching. Supports 25 languages. Use meta-variables: $VAR (single node), $$$ (multiple nodes). IMPORTANT: Patterns must be complete AST nodes (valid code). For functions, include params and body: 'export async function $NAME($$$) { $$$ }' not 'export async function $NAME'. Examples: 'console.log($MSG)', 'def $FUNC($$$):', 'async function $NAME($$$)'",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string"
					},
					"lang": {
						"type": "string",
						"enum": [
							"bash",
							"c",
							"cpp",
							"csharp",
							"css",
							"elixir",
							"go",
							"haskell",
							"html",
							"java",
							"javascript",
							"json",
							"kotlin",
							"lua",
							"nix",
							"php",
							"python",
							"ruby",
							"rust",
							"scala",
							"solidity",
							"swift",
							"typescript",
							"tsx",
							"yaml"
						]
					},
					"paths": {
						"type": "array",
						"items": {
							"type": "string"
						}
					},
					"globs": {
						"type": "array",
						"items": {
							"type": "string"
						}
					},
					"context": {
						"type": "number"
					}
				},
				"required": [
					"pattern",
					"lang"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "background_cancel",
			"sourcePath": "implementations/tools/defs_omo/opencode_background_cancel.yaml",
			"name": "background_cancel",
			"description": "Cancel running background task(s). Use all=true to cancel ALL before final answer.",
			"parameters": {
				"type": "object",
				"properties": {
					"taskId": {
						"type": "string"
					},
					"all": {
						"type": "boolean"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "background_output",
			"sourcePath": "implementations/tools/defs_omo/opencode_background_output.yaml",
			"name": "background_output",
			"description": "Get output from background task. System notifies on completion, so block=true rarely needed.",
			"parameters": {
				"type": "object",
				"properties": {
					"task_id": {
						"type": "string"
					},
					"block": {
						"type": "boolean"
					},
					"timeout": {
						"type": "number"
					}
				},
				"required": [
					"task_id"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "background_task",
			"sourcePath": "implementations/tools/defs_omo/opencode_background_task.yaml",
			"name": "background_task",
			"description": "Run agent task in background. Returns task_id immediately; notifies on completion.\n\nUse `background_output` to get results. Prompts MUST be in English.",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string"
					},
					"prompt": {
						"type": "string"
					},
					"agent": {
						"type": "string"
					},
					"parent_task_id": {
						"type": "string",
						"description": "Optional parent task id for C-Tree lineage tracking."
					},
					"tree_path": {
						"type": "string",
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization."
					},
					"depth": {
						"type": "integer",
						"description": "Optional C-Tree depth indicator."
					},
					"priority": {
						"type": "string",
						"description": "Optional C-Tree priority marker (string or numeric encoded)."
					}
				},
				"required": [
					"description",
					"prompt",
					"agent"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "bash",
			"sourcePath": "implementations/tools/defs_omo/opencode_bash.yaml",
			"name": "bash",
			"description": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nAll commands run in /shared_folders/querylake_server/ray_testing/ray_SCE/misc/oh_my_opencode_runs/goldens/opencode_1.0.193__oh-my-opencode_2.5.1/phase8_async_subagents_live_check_v2/runs/20251226_210616/workspace by default. Use the `workdir` parameter if you need to run a command in a different directory.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use the List tool to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use List to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., rm \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - mkdir \"/Users/name/My Documents\" (correct)\n     - mkdir /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n    - The command argument is required.\n    - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes).\n  If not specified, commands will timeout after 120000ms (2 minutes).\n    - The description argument is required. You must write a clear, concise description of what this command does in 5-10 words.\n    - If the output exceeds 30000 characters, output will be truncated before being\n  returned to you.\n    - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or\n  `echo` commands, unless explicitly instructed or when these commands are truly necessary\n   for the task. Instead, always prefer using the dedicated tools for these commands:\n      - File search: Use Glob (NOT find or ls)\n      - Content search: Use Grep (NOT grep or rg)\n      - Read files: Use Read (NOT cat/head/tail)\n      - Edit files: Use Edit (NOT sed/awk)\n      - Write files: Use Write (NOT echo >/cat <<EOF)\n      - Communication: Output text directly (NOT echo/printf)\n    - When issuing multiple commands:\n      - If the commands are independent and can run in parallel, make multiple Bash tool\n  calls in a single message. For example, if you need to run \"git status\" and \"git diff\",\n  send a single message with two Bash tool calls in parallel.\n      - If the commands depend on each other and must run sequentially, use a single Bash\n  call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" &&\n  git push`). For instance, if one operation must complete before another starts (like\n  mkdir before cp, Write before Bash for git operations, or git add before git commit),\n  run these operations sequentially instead.\n      - Use ';' only when you need to run commands sequentially but don't care if earlier\n  commands fail\n      - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n    - Try to maintain your current working directory throughout the session by using\n  absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly\n  requests it.\n      <good-example>\n      pytest /foo/bar/tests\n      </good-example>\n      <bad-example>\n      cd /foo/bar && pytest tests\n      </bad-example>\n\n# Working Directory\n\nThe `workdir` parameter sets the working directory for command execution. Prefer using `workdir` over `cd <dir> &&` command chains when you simply need to run a command in a different directory.\n\n<good-example>\nworkdir=\"/foo/bar\", command=\"pytest tests\"\n</good-example>\n<good-example>\ncommand=\"pytest /foo/bar/tests\"\n</good-example>\n<bad-example>\ncommand=\"cd /foo/bar && pytest tests\"\n</bad-example>\n\n# Committing changes with git\n\nIMPORTANT: ONLY COMMIT IF THE USER ASKS YOU TO.\n\nIf and only if the user asks you to create a new git commit, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel, each using the Bash tool:\n   - Run a git status command to see all untracked files.\n   - Run a git diff command to see both staged and unstaged changes that will be committed.\n   - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message. When analyzing:\n\n- List the files that have been changed or added\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n- Ensure your language is clear, concise, and to the point\n- Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the message is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft message to ensure it accurately reflects the changes and their purpose\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Add relevant untracked files to the staging area.\n   - Run git status to make sure the commit succeeded.\n\n4. If the commit fails due to pre-commit hook changes, retry the commit ONCE to include these automated changes. If it fails again, it usually means a pre-commit hook is preventing the commit. If the commit succeeds but you notice that files were modified by the pre-commit hook, you MUST amend your commit to include them.\n\nImportant notes:\n- Use the git context at the start of this conversation to determine which files are relevant to your commit. Be careful not to stage and commit files (e.g. with `git add .`) that aren't relevant to your commit.\n- NEVER update the git config\n- DO NOT run additional commands to read or explore code, beyond what is available in the git context\n- DO NOT push to the remote repository\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- Ensure your commit message is meaningful and concise. It should explain the purpose of the changes, not just describe them.\n- Return an empty response - the user will see the git output directly\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff main...HEAD` to understand the full commit history for the current branch (from the time it diverged from the `main` branch)\n\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary. Wrap your analysis process in <pr_analysis> tags:\n\n<pr_analysis>\n- List the commits since diverging from the main branch\n- Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.)\n- Brainstorm the purpose or motivation behind these changes\n- Assess the impact of these changes on the overall project\n- Do not use tools to explore code, beyond what is available in the git context\n- Check for any sensitive information that shouldn't be committed\n- Draft a concise (1-2 bullet points) pull request summary that focuses on the \"why\" rather than the \"what\"\n- Ensure the summary accurately reflects all changes since diverging from the main branch\n- Ensure your language is clear, concise, and to the point\n- Ensure the summary accurately reflects the changes and their purpose (ie. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.)\n- Ensure the summary is not generic (avoid words like \"Update\" or \"Fix\" without context)\n- Review the draft summary to ensure it accurately reflects the changes and their purpose\n</pr_analysis>\n\n3. You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. ALWAYS run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\nEOF\n)\"\n</example>\n\nImportant:\n- NEVER update the git config\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"description": "The command to execute",
						"type": "string"
					},
					"timeout": {
						"description": "Optional timeout in milliseconds",
						"type": "number"
					},
					"workdir": {
						"description": "The working directory to run the command in. Defaults to /shared_folders/querylake_server/ray_testing/ray_SCE/misc/oh_my_opencode_runs/goldens/opencode_1.0.193__oh-my-opencode_2.5.1/phase8_async_subagents_live_check_v2/runs/20251226_210616/workspace. Use this instead of 'cd' commands.",
						"type": "string"
					},
					"description": {
						"description": "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
						"type": "string"
					}
				},
				"required": [
					"command",
					"description"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "call_omo_agent",
			"sourcePath": "implementations/tools/defs_omo/opencode_call_omo_agent.yaml",
			"name": "call_omo_agent",
			"description": "Spawn explore/librarian agent. run_in_background REQUIRED (true=async with task_id, false=sync).\n\nAvailable: - explore: Specialized agent for explore tasks\n- librarian: Specialized agent for librarian tasks\n\nPrompts MUST be in English. Use `background_output` for async results.",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"type": "string"
					},
					"prompt": {
						"type": "string"
					},
					"subagent_type": {
						"type": "string",
						"enum": [
							"explore",
							"librarian"
						]
					},
					"run_in_background": {
						"type": "boolean"
					},
					"session_id": {
						"type": "string"
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type",
					"run_in_background"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "context7_get-library-docs",
			"sourcePath": "implementations/tools/defs_omo/opencode_context7_get-library-docs.yaml",
			"name": "context7_get-library-docs",
			"description": "Fetches up-to-date documentation for a library. You must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query. Use mode='code' (default) for API references and code examples, or mode='info' for conceptual guides, narrative information, and architectural questions.",
			"parameters": {
				"type": "object",
				"properties": {
					"context7CompatibleLibraryID": {
						"type": "string",
						"description": "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
					},
					"mode": {
						"type": "string",
						"enum": [
							"code",
							"info"
						],
						"default": "code",
						"description": "Documentation mode: 'code' for API references and code examples (default), 'info' for conceptual guides, narrative information, and architectural questions."
					},
					"topic": {
						"type": "string",
						"description": "Topic to focus documentation on (e.g., 'hooks', 'routing')."
					},
					"page": {
						"type": "integer",
						"minimum": 1,
						"maximum": 10,
						"description": "Page number for pagination (start: 1, default: 1). If the context is not sufficient, try page=2, page=3, page=4, etc. with the same topic."
					}
				},
				"required": [
					"context7CompatibleLibraryID"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "context7_resolve-library-id",
			"sourcePath": "implementations/tools/defs_omo/opencode_context7_resolve-library-id.yaml",
			"name": "context7_resolve-library-id",
			"description": "Resolves a package/product name to a Context7-compatible library ID and returns a list of matching libraries.\n\nYou MUST call this function before 'get-library-docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\nSelection Process:\n1. Analyze the query to understand what library/package the user is looking for\n2. Return the most relevant match based on:\n- Name similarity to the query (exact matches prioritized)\n- Description relevance to the query's intent\n- Documentation coverage (prioritize libraries with higher Code Snippet counts)\n- Source reputation (consider libraries with High or Medium reputation more authoritative)\n- Benchmark Score: Quality indicator (100 is the highest score)\n\nResponse Format:\n- Return the selected library ID in a clearly marked section\n- Provide a brief explanation for why this library was chosen\n- If multiple good matches exist, acknowledge this but proceed with the most relevant one\n- If no good matches exist, clearly state this and suggest query refinements\n\nFor ambiguous queries, request clarification before proceeding with a best-guess match.",
			"parameters": {
				"type": "object",
				"properties": {
					"libraryName": {
						"type": "string",
						"description": "Library name to search for and retrieve a Context7-compatible library ID."
					}
				},
				"required": [
					"libraryName"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "edit",
			"sourcePath": "implementations/tools/defs_omo/opencode_edit.yaml",
			"name": "edit",
			"description": "Performs exact string replacements in files. \n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. \n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `oldString` is not found in the file with an error \"oldString not found in content\".\n- The edit will FAIL if `oldString` is found multiple times in the file with an error \"oldString found multiple times and requires more code context to uniquely identify the intended match\". Either provide a larger string with more surrounding context to make it unique or use `replaceAll` to change every instance of `oldString`. \n- Use `replaceAll` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The absolute path to the file to modify",
						"type": "string"
					},
					"oldString": {
						"description": "The text to replace",
						"type": "string"
					},
					"newString": {
						"description": "The text to replace it with (must be different from oldString)",
						"type": "string"
					},
					"replaceAll": {
						"description": "Replace all occurrences of oldString (default false)",
						"type": "boolean"
					}
				},
				"required": [
					"filePath",
					"oldString",
					"newString"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "glob",
			"sourcePath": "implementations/tools/defs_omo/opencode_glob.yaml",
			"name": "glob",
			"description": "Fast file pattern matching tool with safety limits (60s timeout, 100 file limit). Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". Returns matching file paths sorted by modification time. Use this tool when you need to find files by name patterns.",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string"
					},
					"path": {
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "grep",
			"sourcePath": "implementations/tools/defs_omo/opencode_grep.yaml",
			"name": "grep",
			"description": "Fast content search tool with safety limits (60s timeout, 10MB output). Searches file contents using regular expressions. Supports full regex syntax (eg. \"log.*Error\", \"function\\s+\\w+\", etc.). Filter files by pattern with the include parameter (eg. \"*.js\", \"*.{ts,tsx}\"). Returns file paths with matches sorted by modification time.",
			"parameters": {
				"type": "object",
				"properties": {
					"pattern": {
						"type": "string"
					},
					"include": {
						"type": "string"
					},
					"path": {
						"type": "string"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "grep_app_searchGitHub",
			"sourcePath": "implementations/tools/defs_omo/opencode_grep_app_searchGitHub.yaml",
			"name": "grep_app_searchGitHub",
			"description": "Find real-world code examples from over a million public GitHub repositories to help answer programming questions.\n\n**IMPORTANT: This tool searches for literal code patterns (like grep), not keywords. Search for actual code that would appear in files:**\n- ✅ Good: 'useState(', 'import React from', 'async function', '(?s)try {.*await'\n- ❌ Bad: 'react tutorial', 'best practices', 'how to use'\n\n**When to use this tool:**\n- When implementing unfamiliar APIs or libraries and need to see real usage patterns\n- When unsure about correct syntax, parameters, or configuration for a specific library\n- When looking for production-ready examples and best practices for implementation\n- When needing to understand how different libraries or frameworks work together\n\n**Perfect for questions like:**\n- \"How do developers handle authentication in Next.js apps?\" → Search: 'getServerSession' with language=['TypeScript', 'TSX']\n- \"What are common React error boundary patterns?\" → Search: 'ErrorBoundary' with language=['TSX']\n- \"Show me real useEffect cleanup examples\" → Search: '(?s)useEffect\\(\\(\\) => {.*removeEventListener' with useRegexp=true\n- \"How do developers handle CORS in Flask applications?\" → Search: 'CORS(' with matchCase=true and language=['Python']\n\nUse regular expressions with useRegexp=true for flexible patterns like '(?s)useState\\(.*loading' to find useState hooks with loading-related variables. Prefix the pattern with '(?s)' to match across multiple lines.\n\nFilter by language, repository, or file path to narrow results.",
			"parameters": {
				"type": "object",
				"properties": {
					"query": {
						"type": "string",
						"description": "The literal code pattern to search for (e.g., 'useState(', 'export function'). Use actual code that would appear in files, not keywords or questions."
					},
					"matchCase": {
						"type": "boolean",
						"description": "Whether the search should be case sensitive",
						"default": false
					},
					"matchWholeWords": {
						"type": "boolean",
						"description": "Whether to match whole words only",
						"default": false
					},
					"useRegexp": {
						"type": "boolean",
						"description": "Whether to interpret the query as a regular expression",
						"default": false
					},
					"repo": {
						"type": "string",
						"description": "Filter by repository.\n            Examples: 'facebook/react', 'microsoft/vscode', 'vercel/ai'.\n            Can match partial names, for example 'vercel/' will find repositories in the vercel org."
					},
					"path": {
						"type": "string",
						"description": "Filter by file path.\n            Examples: 'src/components/Button.tsx', 'README.md'.\n            Can match partial paths, for example '/route.ts' will find route.ts files at any level."
					},
					"language": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"description": "Filter by programming language.\n            Examples: ['TypeScript', 'TSX'], ['JavaScript'], ['Python'], ['Java'], ['C#'], ['Markdown'], ['YAML']"
					}
				},
				"required": [
					"query"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "interactive_bash",
			"sourcePath": "implementations/tools/defs_omo/opencode_interactive_bash.yaml",
			"name": "interactive_bash",
			"description": "Execute tmux commands. Use \"omo-{name}\" session pattern.\n\nBlocked (use bash instead): capture-pane, save-buffer, show-buffer, pipe-pane.",
			"parameters": {
				"type": "object",
				"properties": {
					"tmux_command": {
						"type": "string"
					}
				},
				"required": [
					"tmux_command"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "list",
			"sourcePath": "implementations/tools/defs_omo/opencode_list.yaml",
			"name": "list",
			"description": "Lists files and directories in a given path. The path parameter must be absolute; omit it to use the current workspace directory. You can optionally provide an array of glob patterns to ignore with the ignore parameter. You should generally prefer the Glob and Grep tools, if you know which directories to search.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"path": {
						"description": "The absolute path to the directory to list (must be absolute, not relative)",
						"type": "string"
					},
					"ignore": {
						"description": "List of glob patterns to ignore",
						"type": "array",
						"items": {
							"type": "string"
						}
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "look_at",
			"sourcePath": "implementations/tools/defs_omo/opencode_look_at.yaml",
			"name": "look_at",
			"description": "Analyze media files (PDFs, images, diagrams) via Gemini 2.5 Flash in separate context. Saves main context tokens.",
			"parameters": {
				"type": "object",
				"properties": {
					"file_path": {
						"type": "string"
					},
					"goal": {
						"type": "string"
					}
				},
				"required": [
					"file_path",
					"goal"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_code_action_resolve",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_code_action_resolve.yaml",
			"name": "lsp_code_action_resolve",
			"description": "Resolve and APPLY a code action from lsp_code_actions.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"codeAction": {
						"type": "string"
					}
				},
				"required": [
					"filePath",
					"codeAction"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_code_actions",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_code_actions.yaml",
			"name": "lsp_code_actions",
			"description": "Get available quick fixes, refactorings, and source actions (organize imports, fix all).",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"startLine": {
						"type": "number",
						"minimum": 1
					},
					"startCharacter": {
						"type": "number",
						"minimum": 0
					},
					"endLine": {
						"type": "number",
						"minimum": 1
					},
					"endCharacter": {
						"type": "number",
						"minimum": 0
					},
					"kind": {
						"type": "string",
						"enum": [
							"quickfix",
							"refactor",
							"refactor.extract",
							"refactor.inline",
							"refactor.rewrite",
							"source",
							"source.organizeImports",
							"source.fixAll"
						]
					}
				},
				"required": [
					"filePath",
					"startLine",
					"startCharacter",
					"endLine",
					"endCharacter"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_diagnostics",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_diagnostics.yaml",
			"name": "lsp_diagnostics",
			"description": "Get errors, warnings, hints from language server BEFORE running build.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"severity": {
						"type": "string",
						"enum": [
							"error",
							"warning",
							"information",
							"hint",
							"all"
						]
					}
				},
				"required": [
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_document_symbols",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_document_symbols.yaml",
			"name": "lsp_document_symbols",
			"description": "Get hierarchical outline of all symbols in a file.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					}
				},
				"required": [
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_find_references",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_find_references.yaml",
			"name": "lsp_find_references",
			"description": "Find ALL usages/references of a symbol across the entire workspace.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"line": {
						"type": "number",
						"minimum": 1
					},
					"character": {
						"type": "number",
						"minimum": 0
					},
					"includeDeclaration": {
						"type": "boolean"
					}
				},
				"required": [
					"filePath",
					"line",
					"character"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_goto_definition",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_goto_definition.yaml",
			"name": "lsp_goto_definition",
			"description": "Jump to symbol definition. Find WHERE something is defined.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"line": {
						"type": "number",
						"minimum": 1
					},
					"character": {
						"type": "number",
						"minimum": 0
					}
				},
				"required": [
					"filePath",
					"line",
					"character"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_hover",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_hover.yaml",
			"name": "lsp_hover",
			"description": "Get type info, docs, and signature for a symbol at position.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"line": {
						"type": "number",
						"minimum": 1
					},
					"character": {
						"type": "number",
						"minimum": 0
					}
				},
				"required": [
					"filePath",
					"line",
					"character"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_prepare_rename",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_prepare_rename.yaml",
			"name": "lsp_prepare_rename",
			"description": "Check if rename is valid. Use BEFORE lsp_rename.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"line": {
						"type": "number",
						"minimum": 1
					},
					"character": {
						"type": "number",
						"minimum": 0
					}
				},
				"required": [
					"filePath",
					"line",
					"character"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_rename",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_rename.yaml",
			"name": "lsp_rename",
			"description": "Rename symbol across entire workspace. APPLIES changes to all files.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"line": {
						"type": "number",
						"minimum": 1
					},
					"character": {
						"type": "number",
						"minimum": 0
					},
					"newName": {
						"type": "string"
					}
				},
				"required": [
					"filePath",
					"line",
					"character",
					"newName"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_servers",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_servers.yaml",
			"name": "lsp_servers",
			"description": "List available LSP servers and installation status.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "lsp_workspace_symbols",
			"sourcePath": "implementations/tools/defs_omo/opencode_lsp_workspace_symbols.yaml",
			"name": "lsp_workspace_symbols",
			"description": "Search symbols by name across ENTIRE workspace.",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"type": "string"
					},
					"query": {
						"type": "string"
					},
					"limit": {
						"type": "number"
					}
				},
				"required": [
					"filePath",
					"query"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "read",
			"sourcePath": "implementations/tools/defs_omo/opencode_read.yaml",
			"name": "read",
			"description": "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The filePath parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters\n- Any lines longer than 2000 characters will be truncated\n- Results are returned using cat -n format, with line numbers starting at 1\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.\n- You can read image files using this tool.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"filePath": {
						"description": "The path to the file to read",
						"type": "string"
					},
					"offset": {
						"description": "The line number to start reading from (0-based)",
						"type": "number"
					},
					"limit": {
						"description": "The number of lines to read (defaults to 2000)",
						"type": "number"
					}
				},
				"required": [
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "skill",
			"sourcePath": "implementations/tools/defs_omo/opencode_skill.yaml",
			"name": "skill",
			"description": "Load a skill to get detailed instructions for a specific task. Skills provide specialized knowledge and step-by-step guidance. Use this when a task matches an available skill's description. <available_skills> </available_skills>",
			"parameters": {
				"type": "object",
				"properties": {
					"name": {
						"description": "The skill identifier from available_skills (e.g., 'code-review')",
						"type": "string"
					}
				},
				"required": [
					"name"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "slashcommand",
			"sourcePath": "implementations/tools/defs_omo/opencode_slashcommand.yaml",
			"name": "slashcommand",
			"description": "Execute a slash command within the main conversation.\n\nWhen you use this tool, the slash command gets expanded to a full prompt that provides detailed instructions on how to complete the task.\n\nHow slash commands work:\n- Invoke commands using this tool with the command name (without arguments)\n- The command's prompt will expand and provide detailed instructions\n- Arguments from user input should be passed separately\n\nImportant:\n- Only use commands listed in Available Commands below\n- Do not invoke a command that is already running\n- **CRITICAL**: When user's message starts with '/' (e.g., \"/commit\", \"/plan\"), you MUST immediately invoke this tool with that command. Do NOT attempt to handle the command manually.\n\nCommands are loaded from (priority order, highest wins):\n- .opencode/command/ (opencode-project - OpenCode project-specific commands)\n- ./.claude/commands/ (project - Claude Code project-specific commands)\n- ~/.config/opencode/command/ (opencode - OpenCode global commands)\n- ~/.claude/commands/ (user - Claude Code global commands)\n\nEach command is a markdown file with:\n- YAML frontmatter: description, argument-hint, model, agent, subtask (optional)\n- Markdown body: The command instructions/prompt\n- File references: @path/to/file (relative to command file location)\n- Shell injection: `!`command`` (executes and injects output)\n\nAvailable Commands:\n",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"type": "string"
					}
				},
				"required": [
					"command"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "task",
			"sourcePath": "implementations/tools/defs_omo/opencode_task.yaml",
			"name": "task",
			"description": "Launch a new agent to handle complex, multi-step tasks autonomously.\n\nAvailable agent types and the tools they have access to:\n- build: This subagent should only be called manually by the user.\n- plan: This subagent should only be called manually by the user.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.\n- explore: Contextual grep for codebases. Answers \"Where is X?\", \"Which file has Y?\", \"Find the code that does Z\". Fire multiple in parallel for broad searches. Specify thoroughness: \"quick\" for basic, \"medium\" for moderate, \"very thorough\" for comprehensive analysis.\n- Planner-Sisyphus: Plan agent (OhMyOpenCode version)\n- oracle: Expert technical advisor with deep reasoning for architecture decisions, code analysis, and engineering guidance.\n- librarian: Specialized codebase understanding agent for multi-repository analysis, searching remote codebases, retrieving official documentation, and finding implementation examples using GitHub CLI, Context7, and Web Search. MUST BE USED when users ask to look up code in remote repositories, explain library internals, or find usage examples in open source.\n- frontend-ui-ux-engineer: A designer-turned-developer who crafts stunning UI/UX even without design mockups. Code may be a bit messy, but the visual output is always fire.\n- document-writer: A technical writer who crafts clear, comprehensive documentation. Specializes in README files, API docs, architecture docs, and user guides. MUST BE USED when executing documentation tasks from ai-todo list plans.\n- multimodal-looker: Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text. Extracts specific information or summaries from documents, describes visual content. Use when you need analyzed/extracted data rather than literal file contents.\n- grep-summarizer: Read-only grep specialist (search for strings and report matches).\n- repo-scanner: Read-only repo scanner (list structure, summarize layout).\n\nWhen using the Task tool, you must specify a subagent_type parameter to select which agent type to use.\n\nWhen to use the Task tool:\n- When you are instructed to execute custom slash commands. Use the Task tool with the slash command invocation as the entire prompt. The slash command can take arguments. For example: Task(description=\"Check the file\", prompt=\"/check-file path/to/file.py\")\n\nWhen NOT to use the Task tool:\n- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly\n- If you are searching for a specific class definition like \"class Foo\", use the Glob tool instead, to find the match more quickly\n- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly\n- Other tasks that are not related to the agent descriptions above\n\n\nUsage notes:\n1. Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n2. When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n3. Each agent invocation is stateless unless you provide a session_id. Your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.\n4. The agent's outputs should generally be trusted\n5. Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n6. If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.\n\nExample usage (NOTE: The agents below are fictional examples for illustration only - use the actual agents listed above):\n\n<example_agent_descriptions>\n\"code-reviewer\": use this agent after you are done writing a significant piece of code\n\"greeting-responder\": use this agent when to respond to user greetings with a friendly joke\n</example_agent_description>\n\n<example>\nuser: \"Please write a function that checks if a number is prime\"\nassistant: Sure let me write a function that checks if a number is prime\nassistant: First let me use the Write tool to write a function that checks if a number is prime\nassistant: I'm going to use the Write tool to write the following code:\n<code>\nfunction isPrime(n) {\n  if (n <= 1) return false\n  for (let i = 2; i * i <= n; i++) {\n    if (n % i === 0) return false\n  }\n  return true\n}\n</code>\n<commentary>\nSince a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code\n</commentary>\nassistant: Now let me use the code-reviewer agent to review the code\nassistant: Uses the Task tool to launch the code-reviewer agent\n</example>\n\n<example>\nuser: \"Hello\"\n<commentary>\nSince the user is greeting, use the greeting-responder agent to respond with a friendly joke\n</commentary>\nassistant: \"I'm going to use the Task tool to launch the with the greeting-responder agent\"\n</example>\n",
			"parameters": {
				"type": "object",
				"properties": {
					"description": {
						"description": "A short (3-5 words) description of the task",
						"type": "string"
					},
					"prompt": {
						"description": "The task for the agent to perform",
						"type": "string"
					},
					"subagent_type": {
						"description": "The type of specialized agent to use for this task",
						"type": "string"
					},
					"session_id": {
						"description": "Existing Task session to continue",
						"type": "string"
					},
					"command": {
						"description": "The command that triggered this task",
						"type": "string"
					},
					"parent_task_id": {
						"description": "Optional parent task id for C-Tree lineage tracking.",
						"type": "string"
					},
					"tree_path": {
						"description": "Optional C-Tree path (e.g. root/branch/leaf) for hierarchical task visualization.",
						"type": "string"
					},
					"depth": {
						"description": "Optional C-Tree depth indicator.",
						"type": "integer"
					},
					"priority": {
						"description": "Optional C-Tree priority marker (string or numeric encoded).",
						"type": "string"
					}
				},
				"required": [
					"description",
					"prompt",
					"subagent_type"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "todoread",
			"sourcePath": "implementations/tools/defs_omo/opencode_todoread.yaml",
			"name": "todoread",
			"description": "Use this tool to read your todo list",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "todowrite",
			"sourcePath": "implementations/tools/defs_omo/opencode_todowrite.yaml",
			"name": "todowrite",
			"description": "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos. Feel free to edit the todo list based on new information.\n6. After completing a task - Mark it complete and add any new follow-up tasks\n7. When you start working on a new task, mark the todo as in_progress. Ideally you should only have one todo as in_progress at a time. Complete existing tasks before starting new ones.\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Examples of When to Use the Todo List\n\n<example>\nUser: I want to add a dark mode toggle to the application settings. Make sure you run the tests and build when you're done!\nAssistant: I'll help add a dark mode toggle to your application settings. Let me create a todo list to track this implementation.\n*Creates todo list with the following items:*\n1. Create dark mode toggle component in Settings page\n2. Add dark mode state management (context/store)\n3. Implement CSS-in-JS styles for dark theme\n4. Update existing components to support theme switching\n5. Run tests and build process, addressing any failures or errors that occur\n*Begins working on the first task*\n\n<reasoning>\nThe assistant used the todo list because:\n1. Adding dark mode is a multi-step feature requiring UI, state management, and styling changes\n2. The user explicitly requested tests and build be run afterward\n3. The assistant inferred that tests and build need to pass by adding \"Ensure tests and build succeed\" as the final task\n</reasoning>\n</example>\n\n<example>\nUser: Help me rename the function getCwd to getCurrentWorkingDirectory across my project\nAssistant: Let me first search through your codebase to find all occurrences of 'getCwd'.\n*Uses grep or search tools to locate all instances of getCwd in the codebase*\nAssistant: I've found 15 instances of 'getCwd' across 8 different files. Let me create a todo list to track these changes.\n*Creates todo list with specific items for each file that needs updating*\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant searched to understand the scope of the task\n2. Upon finding multiple occurrences across different files, it determined this was a complex task with multiple steps\n3. The todo list helps ensure every instance is tracked and updated systematically\n4. This approach prevents missing any occurrences and maintains code consistency\n</reasoning>\n</example>\n\n\n<example>\nUser: I need to implement these features for my e-commerce site: user registration, product catalog, shopping cart, and checkout flow.\nAssistant: I'll help implement these features. First, let's add all the features to the todo list.\n*Creates a todo list breaking down each feature into specific tasks based on the project architecture*\nAssistant: Let's start with user registration. This will involve creating database models, API endpoints, and frontend forms that integrate with your existing authentication system.\n\n<reasoning>\nThe assistant used the todo list because:\n1. The user provided multiple complex features to implement in a comma separated list\n2. The todo list helps organize these large features into manageable tasks\n3. This approach allows for tracking progress across the entire implementation\n</reasoning>\n</example>\n\n<example>\nUser: Can you help optimize my React application? It's rendering slowly and has performance issues.</user>\nAssistant: I'll help optimize your React application. First, let me examine your codebase to identify potential performance bottlenecks.\n*Reviews component structure, render patterns, state management, and data fetching*\nAssistant: After analyzing your codebase, I've identified several performance issues. Let me create a todo list to track our optimization efforts.\n*Creates todo list with items like: 1) Implement memoization for expensive calculations in ProductList, 2) Add virtualization for long lists in Dashboard, 3) Optimize image loading in Gallery component, 4) Fix state update loops in ShoppingCart, 5) Review bundle size and implement code splitting*\nLet's start by implementing memoization for the expensive calculations in your ProductList component.</assistant>\n\n<reasoning>\nThe assistant used the todo list because:\n1. First, the assistant examined the codebase to identify specific performance issues\n2. Based on this analysis, it identified multiple optimization opportunities\n3. Performance optimization is a non-trivial task requiring multiple steps\n4. The todo list helps methodically track improvements across different components\n5. This systematic approach ensures all performance bottlenecks are addressed\n</reasoning>\n</example>\n\n## Examples of When NOT to Use the Todo List\n\n<example>\nUser: How do I print 'Hello World' in Python?\nAssistant: In Python, you can print \"Hello World\" with this simple code:\n\npython\nprint(\"Hello World\")\n\nThis will output the text \"Hello World\" to the console when executed.</assistant>\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.\n</reasoning>\n</example>\n\n<example>\nUser: What does the git status command do?\nAssistant: The git status command shows the current state of your working directory and staging area. It displays which changes have been staged, which haven't, and which files aren't being tracked by Git. This is a fundamental command for understanding the current state of your repository before making commits.\n\n<reasoning>\nThe assistant did not use the todo list because this is an informational request with no actual coding task to complete. The user is simply asking for an explanation, not for the assistant to perform multiple steps or tasks.\n</reasoning>\n</example>\n\n<example>\nUser: Can you add a comment to the calculateTotal function to explain what it does?\nAssistant: Sure, let me add a comment to the calculateTotal function to explain what it does.\n* Uses the Edit tool to add a comment to the calculateTotal function *\n\n<reasoning>\nThe assistant did not use the todo list because this is a single, straightforward task confined to one location in the code. Adding a comment doesn't require tracking multiple steps or systematic organization.\n</reasoning>\n</example>\n\n<example>\nUser: Run npm install for me and tell me what happens.\nAssistant: I'll run the npm install command for you.\n\n*Executes: npm install*\n\nThe command completed successfully. Here's the output:\n[Output of npm install command]\n\nAll dependencies have been installed according to your package.json file.\n\n<reasoning>\nThe assistant did not use the todo list because this is a single command execution with immediate results. There are no multiple steps to track or organize, making the todo list unnecessary for this straightforward task.\n</reasoning>\n</example>\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n   - cancelled: Task no longer needed\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Only have ONE task in_progress at any time\n   - Complete current tasks before starting new ones\n   - Cancel tasks that become irrelevant\n\n3. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n\n",
			"parameters": {
				"type": "object",
				"properties": {
					"todos": {
						"description": "The updated todo list",
						"type": "array",
						"items": {
							"type": "object",
							"properties": {
								"content": {
									"description": "Brief description of the task",
									"type": "string"
								},
								"status": {
									"description": "Current status of the task: pending, in_progress, completed, cancelled",
									"type": "string"
								},
								"priority": {
									"description": "Priority level of the task: high, medium, low",
									"type": "string"
								},
								"id": {
									"description": "Unique identifier for the todo item",
									"type": "string"
								}
							},
							"required": [
								"content",
								"status",
								"priority",
								"id"
							],
							"additionalProperties": false
						}
					}
				},
				"required": [
					"todos"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "webfetch",
			"sourcePath": "implementations/tools/defs_omo/opencode_webfetch.yaml",
			"name": "webfetch",
			"description": "- Fetches content from a specified URL\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n",
			"parameters": {
				"type": "object",
				"properties": {
					"url": {
						"description": "The URL to fetch content from",
						"type": "string"
					},
					"format": {
						"description": "The format to return the content in (text, markdown, or html)",
						"type": "string",
						"enum": [
							"text",
							"markdown",
							"html"
						]
					},
					"timeout": {
						"description": "Optional timeout in seconds (max 120)",
						"type": "number"
					}
				},
				"required": [
					"url",
					"format"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "websearch_exa_web_search_exa",
			"sourcePath": "implementations/tools/defs_omo/opencode_websearch_exa_web_search_exa.yaml",
			"name": "websearch_exa_web_search_exa",
			"description": "Search the web using Exa AI - performs real-time web searches and can scrape content from specific URLs. Supports configurable result counts and returns the content from the most relevant websites.",
			"parameters": {
				"type": "object",
				"properties": {
					"query": {
						"type": "string",
						"description": "Websearch query"
					},
					"numResults": {
						"type": "number",
						"description": "Number of search results to return (default: 8)"
					},
					"livecrawl": {
						"type": "string",
						"enum": [
							"fallback",
							"preferred"
						],
						"description": "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')"
					},
					"type": {
						"type": "string",
						"enum": [
							"auto",
							"fast",
							"deep"
						],
						"description": "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search"
					},
					"contextMaxCharacters": {
						"type": "number",
						"description": "Maximum characters for context string optimized for LLMs (default: 10000)"
					}
				},
				"required": [
					"query"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		},
		{
			"id": "write",
			"sourcePath": "implementations/tools/defs_omo/opencode_write.yaml",
			"name": "write",
			"description": "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"description": "The content to write to the file",
						"type": "string"
					},
					"filePath": {
						"description": "The absolute path to the file to write (must be absolute, not relative)",
						"type": "string"
					}
				},
				"required": [
					"content",
					"filePath"
				],
				"additionalProperties": false
			},
			"strict": false,
			"nativePrimary": true
		}
	],
	"defs_pi": [
		{
			"id": "read",
			"sourcePath": "defs_pi/read.yaml",
			"name": "read",
			"description": "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
			"parameters": {
				"type": "object",
				"properties": {
					"limit": {
						"type": "number",
						"description": "Maximum number of lines to read"
					},
					"offset": {
						"type": "number",
						"description": "Line number to start reading from (1-indexed)"
					},
					"path": {
						"type": "string",
						"description": "Path to the file to read (relative or absolute)"
					}
				},
				"required": [
					"path"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "bash",
			"sourcePath": "defs_pi/bash.yaml",
			"name": "bash",
			"description": "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
			"parameters": {
				"type": "object",
				"properties": {
					"command": {
						"type": "string",
						"description": "Bash command to execute"
					},
					"timeout": {
						"type": "number",
						"description": "Timeout in seconds (optional, no default timeout)"
					}
				},
				"required": [
					"command"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "edit",
			"sourcePath": "defs_pi/edit.yaml",
			"name": "edit",
			"description": "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
			"parameters": {
				"type": "object",
				"properties": {
					"newText": {
						"type": "string",
						"description": "New text to replace the old text with"
					},
					"oldText": {
						"type": "string",
						"description": "Exact text to find and replace (must match exactly)"
					},
					"path": {
						"type": "string",
						"description": "Path to the file to edit (relative or absolute)"
					}
				},
				"required": [
					"newText",
					"oldText",
					"path"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "write",
			"sourcePath": "defs_pi/write.yaml",
			"name": "write",
			"description": "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"type": "string",
						"description": "Content to write to the file"
					},
					"path": {
						"type": "string",
						"description": "Path to the file to write (relative or absolute)"
					}
				},
				"required": [
					"content",
					"path"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "grep",
			"sourcePath": "defs_pi/grep.yaml",
			"name": "grep",
			"description": "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
			"parameters": {
				"type": "object",
				"properties": {
					"context": {
						"type": "number",
						"description": "Number of lines to show before and after each match (default: 0)"
					},
					"glob": {
						"type": "string",
						"description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"
					},
					"ignoreCase": {
						"type": "boolean",
						"description": "Case-insensitive search (default: false)"
					},
					"limit": {
						"type": "number",
						"description": "Maximum number of matches to return (default: 100)"
					},
					"literal": {
						"type": "boolean",
						"description": "Treat pattern as literal string instead of regex (default: false)"
					},
					"path": {
						"type": "string",
						"description": "Directory or file to search (default: current directory)"
					},
					"pattern": {
						"type": "string",
						"description": "Search pattern (regex or literal string)"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "find",
			"sourcePath": "defs_pi/find.yaml",
			"name": "find",
			"description": "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
			"parameters": {
				"type": "object",
				"properties": {
					"limit": {
						"type": "number",
						"description": "Maximum number of results (default: 1000)"
					},
					"path": {
						"type": "string",
						"description": "Directory to search in (default: current directory)"
					},
					"pattern": {
						"type": "string",
						"description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "ls",
			"sourcePath": "defs_pi/ls.yaml",
			"name": "ls",
			"description": "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
			"parameters": {
				"type": "object",
				"properties": {
					"limit": {
						"type": "number",
						"description": "Maximum number of entries to return (default: 500)"
					},
					"path": {
						"type": "string",
						"description": "Directory to list (default: current directory)"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		}
	],
	"defs_oh_my_pi": [
		{
			"id": "read",
			"sourcePath": "defs_oh_my_pi/read.yaml",
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "bash",
			"sourcePath": "defs_oh_my_pi/bash.yaml",
			"name": "bash",
			"description": "Runs commands in a persistent shell.\n\nUse ONLY for one binary or a short pipeline that computes a fact (`wc -l`, `sort | uniq -c`, `diff`).\nInline scripts, heredocs, `$(…)`, complex control flow/quoting, and non-trivial pipelines → `eval`.\n\n<instruction>\n- Set `cwd` instead of `cd`.\n- `pty: true` only for terminal interaction (`sudo`, `ssh`).\n- Order-dependent commands use `&&` in one call; independent calls may run concurrently.\n- Internal URIs auto-resolve to paths.\n- aux utils available: mkdir, wc, sort, comm, diff, uniq, base64, cmp, md5sum, sha*sum, b2sum, basename, dirname, readlink, realpath, touch, stat, date, mktemp, seq, yes, printenv, truncate, tac, nproc, uname, whoami, hostname, which, ps, pgrep, pkill, pidwait, top, cut, tee, tr, paste, sed, xargs, jq, rm, mv, ln, ts, sponge, ifne, isutf8, combine, errno\n- `async: true` defers a finite command's result; it does not extend `timeout`.\n</instruction>\n\n<critical>\n- NEVER use shell `grep`/`rg`; use built-in `grep`.\n- List directories with `read` and find paths with `glob`; NEVER use `ls`/`find`.\n- Avoid `head`, `tail`, and redirection: output is captured, truncated, and linked as `artifact://<id>`.\n- Services, watchers, debuggers, and REPLs MUST use `hub` (`op:\"start\"`).\n</critical>\n\nLong foreground calls may auto-background by the configured threshold; the result is injected as a follow-up when the job finishes. NEVER poll a backgrounded job (`sleep`/`ps`/`pgrep`/`top`) — do other work or end your reply and you will be woken with its output.\n`timeout: 0` disables the job deadline; otherwise `timeout` sets it without extending foreground waiting.",
			"parameters": {
				"type": "object",
				"properties": {
					"async": {
						"type": "boolean",
						"description": "run in background"
					},
					"command": {
						"type": "string"
					},
					"cwd": {
						"type": "string"
					},
					"pty": {
						"type": "boolean"
					},
					"timeout": {
						"type": "number",
						"description": "timeout in seconds; 0 disables the command deadline; nonzero values are clamped to 1-3600"
					}
				},
				"required": [
					"command"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "edit",
			"sourcePath": "defs_oh_my_pi/edit.yaml",
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "ast_grep",
			"sourcePath": "defs_oh_my_pi/ast_grep.yaml",
			"name": "ast_grep",
			"description": "Structural code search via ast-grep. Use when syntax shape matters more than text (calls, declarations, language constructs).\n\n<instruction>\n- Narrow each call to one language. `pat` is ONE AST pattern; separate calls for unrelated patterns.\n- Set `lang` when extension inference is ambiguous (for example, `cpp` for `.h`); `.cu` and `.cuh` infer as C++.\n- `$NAME` captures one node; `$_` matches without binding; `$$$NAME` zero-or-more; `$$$` zero-or-more unbound.\n  - Use `$$$NAME`, NOT `$$NAME` (invalid). Names UPPERCASE, whole node — `prefix$VAR` fails.\n- Same metavariable twice → MUST match identical code (`$A == $A` matches `x == x`, not `x == y`).\n- Patterns MUST parse as single AST node. Non-standalone → wrap: `class $_ { … }`.\n- C++ expression-statement calls need trailing `;`: `ns::doThing($ARG);`, `$CALLEE($ARG);`.\n- TS: tolerate annotations — `async function $NAME($$$ARGS): $_ { $$$BODY }`.\n- Declaration forms are distinct — `function foo`, method `foo()`, `const foo = () => {}`; search the right form before concluding absence.\n- Loosest existence check: `pat: \"executeBash\"` with narrow `path`.\n</instruction>\n\n<critical>\n- AVOID repo-root scans — narrow `path` first.\n- Parse issues = query failure, not absence: fix pattern or tighten `path` before concluding \"no matches\".\n- Broad cross-subsystem exploration → Task tool + scout subagent first.\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"lang": {
						"type": "string",
						"description": "language override, e.g. cpp for ambiguous .h files"
					},
					"pat": {
						"type": "string",
						"description": "ast pattern"
					},
					"path": {
						"type": "string",
						"description": "file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
					},
					"skip": {
						"type": "number",
						"description": "matches to skip"
					}
				},
				"required": [
					"pat"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "ast_edit",
			"sourcePath": "defs_oh_my_pi/ast_edit.yaml",
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
								"out": {
									"type": "string",
									"description": "replacement template"
								},
								"pat": {
									"type": "string",
									"description": "ast pattern"
								}
							},
							"required": [
								"out",
								"pat"
							],
							"additionalProperties": false
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "ask",
			"sourcePath": "defs_oh_my_pi/ask.yaml",
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
								"header": {
									"type": "string",
									"description": "optional short display chip for rich ask dialogs"
								},
								"id": {
									"type": "string",
									"description": "question id"
								},
								"multi": {
									"type": "boolean",
									"description": "allow multiple selections"
								},
								"options": {
									"type": "array",
									"items": {
										"type": "object",
										"properties": {
											"description": {
												"type": "string",
												"description": "optional explanatory text displayed below the label"
											},
											"label": {
												"type": "string",
												"description": "display label"
											},
											"preview": {
												"type": "string",
												"description": "optional rich preview content for interactive ask dialogs"
											}
										},
										"required": [
											"label"
										],
										"additionalProperties": false
									},
									"description": "available options"
								},
								"question": {
									"type": "string",
									"description": "question text"
								},
								"recommended": {
									"type": "number",
									"description": "recommended option index"
								}
							},
							"required": [
								"id",
								"options",
								"question"
							],
							"additionalProperties": false
						},
						"minItems": 1,
						"description": "questions to ask"
					}
				},
				"required": [
					"questions"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "debug",
			"sourcePath": "defs_oh_my_pi/debug.yaml",
			"name": "debug",
			"description": "Debugger access. Prefer over bash for program state, breakpoints, stepping, or thread inspection.\nOnly one active session at a time. `program` is a target path, not a shell command.\nDirectories need a directory-capable adapter (e.g. `dlv`).",
			"parameters": {
				"type": "object",
				"properties": {
					"access_type": {
						"enum": [
							"read",
							"write",
							"readWrite"
						],
						"type": "string"
					},
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
					"adapter": {
						"type": "string",
						"description": "configured adapter id (gdb, lldb-dap, debugpy, dlv, rdbg, or dap.json entry)"
					},
					"allow_partial": {
						"type": "boolean"
					},
					"args": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"description": "program arguments"
					},
					"arguments": {
						"type": "object",
						"properties": {},
						"additionalProperties": false,
						"description": "custom request arguments"
					},
					"command": {
						"type": "string",
						"description": "custom dap request command"
					},
					"condition": {
						"type": "string",
						"description": "breakpoint condition"
					},
					"context": {
						"type": "string",
						"description": "evaluate context: watch | repl | hover | variables | clipboard"
					},
					"count": {
						"type": "number",
						"description": "bytes to read"
					},
					"cwd": {
						"type": "string"
					},
					"data": {
						"type": "string",
						"description": "base64 memory payload"
					},
					"data_id": {
						"type": "string",
						"description": "data breakpoint id"
					},
					"expression": {
						"type": "string",
						"description": "expression to evaluate"
					},
					"file": {
						"type": "string",
						"description": "source file"
					},
					"frame_id": {
						"type": "number"
					},
					"function": {
						"type": "string",
						"description": "function name"
					},
					"hit_condition": {
						"type": "string"
					},
					"host": {
						"type": "string",
						"description": "remote attach host"
					},
					"instruction_count": {
						"type": "number"
					},
					"instruction_offset": {
						"type": "number"
					},
					"instruction_reference": {
						"type": "string"
					},
					"levels": {
						"type": "number",
						"description": "max stack frames"
					},
					"line": {
						"type": "number",
						"description": "source line"
					},
					"memory_reference": {
						"type": "string",
						"description": "memory reference or address"
					},
					"module_count": {
						"type": "number"
					},
					"name": {
						"type": "string",
						"description": "variable or data name"
					},
					"offset": {
						"type": "number"
					},
					"pid": {
						"type": "number",
						"description": "process id for attach"
					},
					"port": {
						"type": "number",
						"description": "remote attach port"
					},
					"program": {
						"type": "string",
						"description": "debug target path; Delve accepts Go package directories"
					},
					"resolve_symbols": {
						"type": "boolean"
					},
					"scope_id": {
						"type": "number",
						"description": "scope variables reference"
					},
					"start_module": {
						"type": "number"
					},
					"timeout": {
						"type": "number",
						"description": "per-request timeout seconds"
					},
					"variable_ref": {
						"type": "number",
						"description": "variable reference"
					}
				},
				"required": [
					"action"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "eval",
			"sourcePath": "defs_oh_my_pi/eval.yaml",
			"name": "eval",
			"description": "Run one step of code in a persistent kernel. State persists across calls and `task` subagents.\nEval `agent()` children use independent kernels.\n\nWork incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.\nTwo or more independent items → named `workpool()` + `.push(…)`; poll outside eval with `hub wait` on the pool name. Handles + `wait()` are for dependency-coupled results.\n\nTop-level `await` works; `asyncio.run(…)` raises error.\nJS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.\n\nOn error, fix and re-run only the failing step. Earlier statements may already have produced side effects.\n\n<instruction>\n- Reusable setup → write a script once, then use `%load ./setup.py` as `code`. Definitions persist; source is not echoed. Quote paths containing spaces; `local://` works.\n- `%load` executes again only when explicitly called. Editing a file alone does not reload it.\n- Missing Python dependency → identify its distribution, then use `%pip install pillow` as `code`; it installs into the kernel's interpreter. Import names can differ (`PIL` → `pillow`); do not install an exception's name blindly.\n- Missing JS dependency → use `%bun add csv-parse` as `code`.\n- Percent commands are standalone cells. After installation, retry only the failed import/step—not earlier side effects.\n- JS packages go to a managed environment reused across sessions in the same project; kernel variables remain separate. Rare explicit target change → `%environment project` (permits project dependency changes) or `%environment managed`.\n- Package installation preserves kernel state. A kernel-loss notice means setup must be loaded again. Compaction alone does not reset a live kernel.\n</instruction>\n\n<prelude>\nPython: sync, kwargs. JS: async, ONE trailing object literal, never positional.\n```\ndisplay(value) → None        print(value, ...) → None\nread(path, offset?=1, limit?=None) → str\nwrite(path, content) → str\nenv(key?=None, value?=None) → str | None | dict\noutput(*ids, format?=\"raw\", query?=None, offset?=None, limit?=None) → str | dict | list[dict]\nawait tool.<name>(args) → unknown\n    Invoke any session tool; `args` = its parameter object. Async: `await tool.read({...})`.\ncompletion(prompt, model?=\"default\"|\"smol\"|\"slow\", system?=None, schema?=None) → CompletionHandle\n    Oneshot, stateless (no history/tools); returns immediately. `.wait()` → str (parsed object with `schema`). `model`: \"smol\" fast | \"default\" session | \"slow\" most capable.\nawait judge(state, questions) → `{id: answer}`\n    Typed judgment over one `state` (str | JSON object | JSON array). Every question sees the same state and is answered independently: batch independent questions into one call. Cheap and fast (TypeSafe when credentialed, else the tiny/smol chat model); prefer over `completion()` for classification, yes/no, ranking. Two or more states → `judge_batch`, never a loop of `judge()`.\n    `questions`: `{id: q}` where q is one of\n      `{type: \"choice\", instructions, criteria: {label: rubric | None, …}}` → `{choice, probabilities: {label: p}, confidence}` (≥2 labels)\n      `{type: \"bool\", instructions, criteria?: {true?: str, false?: str}}` → `{bool: P(yes)}`\n      `{type: \"score\", instructions, criteria: [lowest, …, highest]}` → `{score, probabilities: {\"0\": p, …}, confidence}` (≥2 levels; score is the probability-weighted level index)\njudge_batch(states, questions, concurrency?=32, retries?=1, min_ok?=1, intent?=None) → JudgmentBatch\n    Same `questions` over every state (`{key: state}` or a list keyed by index), run and owned by the host — it outlives the cell. `intent` is an optional nonempty progress/job label (default `\"Judging\"`). Returns at once; pull settled items in bounded slices across cells: `await b.drain(timeout?)` → `[(key, item)]` settled since the last drain (`[]` on timeout; `item.answers` on success, else `item.error`, never raised); `async for k, item in b.drain_iter(timeout)` until timeout or completion; `b.status()` → `{intent, done, total, failed, cost, running, model}`; `b.results()` → `{key: answers}` so far; `b.failed()` → `{key: error}`; `b.cancel()`; `b.close()` releases it. `drain()` raises only when the run died wholesale (no judge, or fewer than `min_ok` answered). `b.id` is an async job id: completion auto-delivers a summary, `hub wait ids:[b.id]` works, `judge_batch.attach(id)` re-creates the ref after a reset.\nagent(prompt, agent?=\"task\", label?=None, schema?=None, schemaMode?=\"permissive\", isolated?=None, apply?=None, merge?=None, tools?=None) → AgentHandle\n    Spawns a background subagent and returns immediately. `agent` selects a discovered agent; omit it to use `task`. Handle: `.id`, `.handle` (\"agent://<id>\"), `.status`, `.done()`, `.wait(timeout?)` → final text (parsed with `schema`), `.send(message)`, `.cancel()`, `.output()`. Unwaited results auto-deliver like async jobs. `schema` overrides agent/session schemas; `isolated` requests a worktree; `apply`/`merge` control its changes. `tools`: names of your @tool-defined tools the child may call.\n    JS: ONE trailing object — agent(prompt, { agent, label, schema, schemaMode, isolated, apply, merge, tools }).\nworkpool(agent?=None, name?=None, context?=None, tools?=None) → WorkPool\n    Default for 2+ independent items. `.push(*items)`; `.status()`; `.peek()`; `.close()`. Pool name = async job id; results auto-deliver, or poll outside eval with `hub wait` and `ids:[pool.name]`. `eval.workpool.freshAgents=true` uses a new agent per item.\nwait(handles, timeout?=None, raise_errors?=True) → list\n    Barrier over agent/completion handles, results in input order. `raise_errors=False` keeps the error in its slot. JS: wait(handles, { timeout, raiseErrors }).\n@tool / tool(fn, name=None, description=None)tool(fn, { name?, description?, parameters? })\n    Define a tool that runs in this kernel (schema inferred from type hints); reference by name in `task` items' `tools`, `agent(tools=…)`, `workpool(tools=…)`. `tool.defined()`, `tool.undefine(name)`.\nlog(message) → None         phase(title) → None\nbudget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()``await budget.total()`, `await budget.spent()`, `await budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.\n```\n</prelude>\n<dag>\nAcyclic waves of handles:\n- **Name nodes.** `h = agent(…)` returns at once; `h.handle` is `agent://<id>`.\n- **Wire edges.** Put an upstream `.wait()` result or `.handle` in the downstream prompt. Bulk: `write(\"local://<name>.md\", …)`.\n- **`wait(hs)`** = wave barrier. Open-ended item streams → `workpool()`.\n- **Isolate failure.** `wait(hs, raise_errors=False)` keeps a failure in its slot; only that subtree degrades.\n- **Acyclic only.** No node waits on its own descendant.\n</dag>\n\n<critical>\nPrior top-level names survive into the next cell — reuse; NEVER repeat successful setup. After installing a missing dependency, retry its failed import, not the whole failed cell. Re-read only if file changed since last read.\n</critical>\n\nLong-running cells may auto-background by the configured threshold and deliver later; the kernel stays busy until the cell finishes.\n`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.",
			"parameters": {
				"type": "object",
				"properties": {
					"code": {
						"type": "string",
						"description": "code or a standalone % command to run in this eval call. Top-level await works."
					},
					"language": {
						"enum": [
							"py",
							"js"
						],
						"type": "string",
						"description": "runtime: \"py\" for the IPython kernel, \"js\" for the persistent JS VM"
					},
					"reset": {
						"type": "boolean",
						"description": "wipe this language's kernel before running. Other languages are untouched."
					},
					"timeout": {
						"type": "number",
						"description": "timeout for this eval call in seconds; 0 disables the cell timeout"
					},
					"title": {
						"type": "string",
						"description": "short label shown in transcript (e.g. \"imports\", \"load config\")"
					}
				},
				"required": [
					"code",
					"language"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "ssh",
			"sourcePath": "defs_oh_my_pi/ssh.yaml",
			"name": "ssh",
			"description": "Tool 'ssh' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "github",
			"sourcePath": "defs_oh_my_pi/github.yaml",
			"name": "github",
			"description": "`gh` op wrapper: repos/files, PRs, search, checkout, push, Actions watch. Read issue/PR: `issue://<N>`/`pr://<N>`. PR diffs: `pr://<N>/diff` (files); `pr://<N>/diff/<i>` (file slice, 1-indexed); `pr://<N>/diff/all` (full).\n\n<instruction>\nSelect via `op`.\n- `repo`: `[host/]owner/repo`; qualify the host for a repo outside the checkout's own GitHub instance.\n- `repo_view`: omit `repo` → current checkout.\n- `file_read`: read `path` from `repo`; omit `repo` → current checkout, `branch` → default branch.\n- `pr_create`: `head` defaults current branch.\n- `pr_checkout`: PR(s) → dedicated git worktrees, never working tree; array `pr` batches multiple in one call.\n- `pr_push`: requires prior `op: pr_checkout`.\n- `search_issues`/`search_prs`/`search_commits`/`search_repos`: `query` optional with `since`/`until`; omit for date-only filter. `search_code`: `query` required; rejects `since`/`until`.\n- `search_*`: `repo` defaults current checkout's `owner/repo`; search elsewhere with `repo:`/`org:`/`user:` in `query`. `search_repos`: ignores `repo`; scope via `org:`/`language:` in `query`.\n- Boolean `AND`/`OR`/`NOT` combine text terms, not qualifiers; never place them between qualifiers.\n- `since`/`until`: relative `<n>` + `m`/`h`/`d`/`w`/`mo`/`y` (e.g. `3d`, `2w`), ISO date `YYYY-MM-DD`, or ISO datetime. `dateField: \"updated\"`: update time (issues/PRs), push time (repos), never creation.\n- `run_watch`: omit `run` → every run for current HEAD; `branch` defaults current. Fast-fails first job failure.\n</instruction>\n\n<output>\nConcise summary per op. `run_watch` failures save full logs to a session artifact.\n</output>\n\n<critical>\nGitHub-hosted repository file: MUST use `file_read`; NEVER `curl`/`wget`.\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"assignee": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"description": "assignees"
					},
					"base": {
						"type": "string",
						"description": "pr base branch"
					},
					"body": {
						"type": "string",
						"description": "pr body markdown"
					},
					"branch": {
						"type": "string",
						"description": "branch"
					},
					"dateField": {
						"enum": [
							"created",
							"updated"
						],
						"type": "string",
						"description": "date field"
					},
					"draft": {
						"type": "boolean",
						"description": "open pr as draft"
					},
					"fill": {
						"type": "boolean",
						"description": "auto-fill pr title/body from commits"
					},
					"force": {
						"type": "boolean",
						"description": "reset existing local branch"
					},
					"forceWithLease": {
						"type": "boolean",
						"description": "force-with-lease push"
					},
					"head": {
						"type": "string",
						"description": "pr head branch"
					},
					"label": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"description": "labels"
					},
					"limit": {
						"type": "number",
						"description": "max results"
					},
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
					"query": {
						"type": "string",
						"description": "search query"
					},
					"repo": {
						"type": "string",
						"description": "owner/repo"
					},
					"reviewer": {
						"type": "array",
						"items": {
							"type": "string"
						},
						"description": "reviewers"
					},
					"run": {
						"type": "string",
						"description": "actions run id or url"
					},
					"since": {
						"type": "string",
						"description": "lower-bound date filter"
					},
					"tail": {
						"type": "number",
						"description": "log lines per failed job"
					},
					"title": {
						"type": "string",
						"description": "pr title"
					},
					"until": {
						"type": "string",
						"description": "upper-bound date filter"
					}
				},
				"required": [
					"op"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "glob",
			"sourcePath": "defs_oh_my_pi/glob.yaml",
			"name": "glob",
			"description": "Globs files, directories, and path-backed internal URLs with fast pattern matching.\n\n<instruction>\n- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.\n- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by directory; directories end in `/`.\n</output>\n\n<avoid>\n\nOpen-ended multi-round discovery → Task + scout.\n</avoid>",
			"parameters": {
				"type": "object",
				"properties": {
					"gitignore": {
						"type": "boolean",
						"description": "respect gitignore"
					},
					"hidden": {
						"type": "boolean",
						"description": "include hidden files"
					},
					"limit": {
						"type": "number",
						"description": "max results"
					},
					"path": {
						"type": "string",
						"description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "grep",
			"sourcePath": "defs_oh_my_pi/grep.yaml",
			"name": "grep",
			"description": "Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches may time out → narrow scope or use `glob` first.\n- One-file line selector: `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell `grep`/`rg`.\n\n- Open-ended multi-round search MUST use Task + scout, not chained calls.\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"case": {
						"type": "boolean",
						"description": "case-sensitive search"
					},
					"gitignore": {
						"type": "boolean",
						"description": "respect gitignore"
					},
					"path": {
						"type": "string",
						"description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
					},
					"pattern": {
						"type": "string",
						"description": "regex pattern"
					},
					"skip": {
						"type": "number",
						"description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "lsp",
			"sourcePath": "defs_oh_my_pi/lsp.yaml",
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
					"apply": {
						"type": "boolean"
					},
					"file": {
						"type": "string"
					},
					"line": {
						"type": "number"
					},
					"new_name": {
						"type": "string"
					},
					"payload": {
						"type": "string"
					},
					"query": {
						"type": "string"
					},
					"symbol": {
						"type": "string"
					},
					"timeout": {
						"type": "number",
						"minimum": 5,
						"maximum": 300,
						"description": "Timeout in seconds (default 20; range 5–300)."
					}
				},
				"required": [
					"action"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "inspect_image",
			"sourcePath": "defs_oh_my_pi/inspect_image.yaml",
			"name": "inspect_image",
			"description": "Tool 'inspect_image' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "browser",
			"sourcePath": "defs_oh_my_pi/browser.yaml",
			"name": "browser",
			"description": "Tool 'browser' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "checkpoint",
			"sourcePath": "defs_oh_my_pi/checkpoint.yaml",
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "rewind",
			"sourcePath": "defs_oh_my_pi/rewind.yaml",
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "task",
			"sourcePath": "defs_oh_my_pi/task.yaml",
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
								"isolated": {
									"type": "boolean"
								},
								"name": {
									"type": "string"
								},
								"outputSchema": {
									"anyOf": [
										{
											"type": "object",
											"additionalProperties": false
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
								"task": {
									"type": "string"
								},
								"tools": {
									"type": "array",
									"items": {
										"type": "string"
									}
								}
							},
							"required": [
								"task"
							],
							"additionalProperties": false
						}
					}
				},
				"required": [
					"context",
					"tasks"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "job",
			"sourcePath": "defs_oh_my_pi/job.yaml",
			"name": "job",
			"description": "Tool 'job' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "irc",
			"sourcePath": "defs_oh_my_pi/irc.yaml",
			"name": "irc",
			"description": "Tool 'irc' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "todo",
			"sourcePath": "defs_oh_my_pi/todo.yaml",
			"name": "todo",
			"description": "**Tasks: verbatim content strings, NEVER auto-generated IDs; no \"task-1\"/\"task-N\". Pass content in `task`.**\n\nAfter each successful state-changing op: if nothing is `in_progress`, the earliest `pending` task (phase order) auto-promotes to `in_progress`; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move pointer back to an earlier phase—expected; completed tasks NEVER revert.\n\n## Operations\n\n|`op`|Fields|Effect|\n|---|---|---|\n|`init`|`list: [{phase, items: string[]}]`|Initialize full list; replaces existing|\n|`init`|`items: string[]`|Flattened single-phase init|\n|`start`|`task`|Mark in progress|\n|`done`|`task` or `phase`|Mark completed|\n|`drop`|`task` or `phase`|Mark abandoned|\n|`block`|`task` or `phase`; optional `reason`|Mark blocked: awaiting external input; never auto-promotes; excluded from stop-time incomplete-todo reminder|\n|`unblock`|`task` or `phase`|Blocked task → `pending`|\n|`rm`|optional `task` or `phase`|Remove task/phase; omit both → clear|\n|`append`|`phase`; `items: string[]`|Append tasks to phase; lazily creates phase|\n|`view`|—|Read-only; echo list|\n\n## Anatomy\n\n- Task content: 5–10 words; what, not how; unique identifier.\n- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.\n\n## Rules\n\n- Mark tasks done immediately after finishing; complete phases in order.\n- NEVER make a todo call the turn's only tool call. Batch with real work: `init` with first reads/edits; each `done`/`start` with next action. Solo todo turns waste a round trip.\n- Waiting on something you can't act on—a user decision, another agent, external service: `block` task (optional `reason`); remains tracked but avoids stop reminder. Blocking the active task hands `in_progress` to the next `pending` task, never back to the blocked one. `unblock` when actionable. If blocker agent-actionable, `append` an unblocking task instead.\n- Keep introduced `task`/`phase` strings stable.\n- Lost exact task text: `view` echoes list; NEVER guess from memory.\n\n## Create a list\n\n- Task requires 3+ distinct steps.\n- User explicitly requests one.\n- User provides a set of tasks.\n- New instructions arrive mid-task: capture before proceeding.\n\n<critical>\nUser gives multi-step plan—phased todo, numbered/bulleted checklist, or \"N bugs/items/tasks\":\n- MUST `init` every item as its own task before working.\n- Enumerate all; NEVER summarize into fewer tasks, sample \"the important ones\", drop items, or track the rest from memory.\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"items": {
						"type": "array",
						"items": {
							"type": "string",
							"description": "task content"
						},
						"description": "tasks for single-phase init or append"
					},
					"list": {
						"type": "array",
						"items": {
							"type": "object",
							"properties": {
								"items": {
									"type": "array",
									"items": {
										"type": "string",
										"description": "task content"
									},
									"minItems": 1,
									"description": "tasks for this phase"
								},
								"phase": {
									"type": "string",
									"description": "phase name"
								}
							},
							"required": [
								"items",
								"phase"
							],
							"additionalProperties": false
						},
						"description": "phased task list (init)"
					},
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
					"phase": {
						"type": "string",
						"description": "phase name"
					},
					"reason": {
						"type": "string",
						"description": "blocker note (block op)"
					},
					"task": {
						"type": "string",
						"description": "task content"
					}
				},
				"required": [
					"op"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "web_search",
			"sourcePath": "defs_oh_my_pi/web_search.yaml",
			"name": "web_search",
			"description": "Web search: current information beyond knowledge cutoff.\n\n<instruction>\n- SHOULD prefer primary sources (papers, official docs); corroborate key claims with multiple sources.\n- MUST link cited sources in final response.\n- NEVER use for programmatically accessible content or known URLs (GitHub repos/issues, known arXiv papers, Wikipedia pages, official docs) — `read` URL directly.\n- `query`: every provider supports Google-style `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `\"exact phrase\"`, `-term`, `OR`. Map constraints to native filters when available; otherwise filter results leniently. If a constraint matches nothing, relax and report it; do not return zero results.\n</instruction>",
			"parameters": {
				"type": "object",
				"properties": {
					"limit": {
						"type": "number"
					},
					"max_tokens": {
						"type": "number"
					},
					"num_search_results": {
						"type": "number"
					},
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
					"temperature": {
						"type": "number"
					}
				},
				"required": [
					"query"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "search_tool_bm25",
			"sourcePath": "defs_oh_my_pi/search_tool_bm25.yaml",
			"name": "search_tool_bm25",
			"description": "Tool 'search_tool_bm25' is not available in the native host.",
			"parameters": {
				"type": "object",
				"properties": {},
				"required": [],
				"additionalProperties": false
			},
			"nativePrimary": true,
			"strict": true
		},
		{
			"id": "write",
			"sourcePath": "defs_oh_my_pi/write.yaml",
			"name": "write",
			"description": "Creates or overwrites file at specified path.\n\n<conditions>\n- Creating new files explicitly required by task\n- Replacing entire file contents when editing would be more complex\n- Supports `.zip` (and ZIP-based `.jar`/`.war`/`.ear`/`.apk`), `.tar`, `.tar.gz`/`.tgz`, `.tar.zst`, and `.asar` archive entries via `archive.ext:path/inside/archive`; other archive formats (`.rar`, `.7z`, `.iso`, …) are read-only\n- Supports SQLite row operations via `db.sqlite:table` (insert), `db.sqlite:table:key` (update with JSON content, delete with empty content)\n</conditions>\n\n<critical>\n- You SHOULD use Edit tool for modifying existing files\n- You NEVER create documentation files (*.md, README) unless explicitly requested\n- You NEVER use emojis unless requested\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"type": "string",
						"description": "file content"
					},
					"path": {
						"type": "string",
						"description": "file path"
					}
				},
				"required": [
					"content",
					"path"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "memory_edit",
			"sourcePath": "defs_oh_my_pi/memory_edit.yaml",
			"name": "memory_edit",
			"description": "Edit Mnemopi long-term memories by id. Only ids returned by `recall`.\n\nOperations:\n- `update`: working memory; replace content and/or importance.\n- `forget`: permanently delete working memory.\n- `invalidate`: softly supersede working or episodic memory; optional `replacement_id`.\n\nFact ids — `recall` results marked `[facts]`: read-only. Inspect with `read memory://<id>`; any edit op → `not_editable`.\n\nPrefer `invalidate` for stale memory whose history may still be useful. Use `forget` only for content requiring hard deletion.\n\nMUST read full memory before `update`. Recall previews clipped: trailing `…` marks truncation; `full_length` original size. `update` replaces content wholesale → updating a preview deletes its unseen tail. First `read memory://<id>`; pass merged content in `content`.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"content": {
						"type": "string",
						"description": "replacement content for update"
					},
					"id": {
						"type": "string",
						"description": "memory id from recall output"
					},
					"importance": {
						"type": "number",
						"description": "replacement importance for update (0–1)"
					},
					"op": {
						"enum": [
							"update",
							"forget",
							"invalidate"
						],
						"type": "string",
						"description": "memory edit operation"
					},
					"replacement_id": {
						"type": "string",
						"description": "replacement memory id for invalidate"
					}
				},
				"required": [
					"id",
					"op"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "retain",
			"sourcePath": "defs_oh_my_pi/retain.yaml",
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
							],
							"additionalProperties": false
						},
						"minItems": 1,
						"description": "memories to retain"
					}
				},
				"required": [
					"items"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "recall",
			"sourcePath": "defs_oh_my_pi/recall.yaml",
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
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "reflect",
			"sourcePath": "defs_oh_my_pi/reflect.yaml",
			"name": "reflect",
			"description": "`reflect`: synthesizes a coherent response from relevant long-term memories; unlike `recall`, blends them.\n\nUse for open-ended questions spanning many stored facts: \"What do you know about this user?\", \"Summarize project decisions.\", \"What are my preferences for X?\"\n\n`context` optional; focuses synthesis on a specific angle or sub-topic.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"context": {
						"type": "string",
						"description": "optional context"
					},
					"query": {
						"type": "string",
						"description": "question to answer"
					}
				},
				"required": [
					"query"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "learn",
			"sourcePath": "defs_oh_my_pi/learn.yaml",
			"name": "learn",
			"description": "Capture reusable lessons in long-term memory; optionally mint/enhance a managed skill in the same call.\n\nUse after solving insight likely to pay off again: a non-obvious fix, discovered project convention, or workflow that worked.\n\n`skill` optional; provide only for a repeatable procedure worth codifying as `SKILL.md`, not a fact. Managed skills: isolated `~/.omp/agent/managed-skills`; surfaced as normal skills next session; NEVER touch user-authored skills. Frontmatter: generated from `name` and `description`.\n\nCapture sparingly, specifically: one strong reusable lesson > several vague ones.\n",
			"parameters": {
				"type": "object",
				"properties": {
					"context": {
						"type": "string",
						"description": "optional source context for the lesson"
					},
					"memory": {
						"type": "string",
						"description": "the durable, self-contained lesson to remember (what, when, why)"
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
							"body": {
								"type": "string",
								"description": "the SKILL.md body in markdown (no frontmatter)"
							},
							"description": {
								"type": "string",
								"description": "one-line description of when to use the skill"
							},
							"name": {
								"type": "string",
								"description": "kebab-case skill name"
							}
						},
						"required": [
							"action",
							"body",
							"description",
							"name"
						],
						"description": "also create or enhance a managed skill in the same call",
						"additionalProperties": false
					}
				},
				"required": [
					"memory"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "manage_skill",
			"sourcePath": "defs_oh_my_pi/manage_skill.yaml",
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
					"body": {
						"type": "string",
						"description": "the SKILL.md body in markdown, no frontmatter (required for create/update)"
					},
					"description": {
						"type": "string",
						"description": "one-line description of when to use the skill (required for create/update)"
					},
					"name": {
						"type": "string",
						"description": "kebab-case skill name"
					}
				},
				"required": [
					"action",
					"name"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "search",
			"sourcePath": "defs_oh_my_pi/search.yaml",
			"name": "search",
			"description": "Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches may time out → narrow scope or use `glob` first.\n- One-file line selector: `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell `grep`/`rg`.\n\n- Open-ended multi-round search MUST use Task + scout, not chained calls.\n</critical>",
			"parameters": {
				"type": "object",
				"properties": {
					"case": {
						"type": "boolean",
						"description": "case-sensitive search"
					},
					"gitignore": {
						"type": "boolean",
						"description": "respect gitignore"
					},
					"path": {
						"type": "string",
						"description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
					},
					"pattern": {
						"type": "string",
						"description": "regex pattern"
					},
					"skip": {
						"type": "number",
						"description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"
					}
				},
				"required": [
					"pattern"
				],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		},
		{
			"id": "find",
			"sourcePath": "defs_oh_my_pi/find.yaml",
			"name": "find",
			"description": "Globs files, directories, and path-backed internal URLs with fast pattern matching.\n\n<instruction>\n- `path`: glob, file, directory, or path-backed internal URL; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- `memory://` glob patterns are supported. `ssh://` has no local path; use `read`. Other internal URLs accept exact paths only.\n- `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by directory; directories end in `/`.\n</output>\n\n<avoid>\n\nOpen-ended multi-round discovery → Task + scout.\n</avoid>",
			"parameters": {
				"type": "object",
				"properties": {
					"gitignore": {
						"type": "boolean",
						"description": "respect gitignore"
					},
					"hidden": {
						"type": "boolean",
						"description": "include hidden files"
					},
					"limit": {
						"type": "number",
						"description": "max results"
					},
					"path": {
						"type": "string",
						"description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
					}
				},
				"required": [],
				"additionalProperties": false
			},
			"strict": true,
			"nativePrimary": true
		}
	]
} as const;
