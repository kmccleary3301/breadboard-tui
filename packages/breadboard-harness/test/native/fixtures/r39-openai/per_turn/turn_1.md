

SYSTEM MESSAGE - AVAILABLE TOOLS
NATIVE TOOLS AVAILABLE VIA TOOL CALLING:
- create_file_from_block
- eval
- list_dir
- mark_task_complete
- read_file
- run_shell

ADDITIONAL TEXT-INVOKED FUNCTIONS:
<FUNCTIONS>

You may call a python functions to execute an action.
To do so, you must wrap it in the following template:

<TOOL_CALL> function_name(arg_1=value1, arg2=value2, ...) </TOOL_CALL>

and it is wrapped as <TOOL_CALL> ... </TOOL_CALL>.
The call MUST begin with the sequence "<TOOL_CALL>" and MUST end with the sequence "</TOOL_CALL>" to be valid.
The inner content must be valid python code.

Here are your available functions:

def apply_unified_patch(		patch: string	 # Unified-diff text; use ```diff fenced blocks when authoring
)
"""
Apply a unified-diff patch (edits/additions/deletions) to files
"""

def TodoWrite(		todos: array	 # Ordered todo items. Include the entire list every time you update progress.
)
"""
Write or update the full todo checklist. Provide the entire ordered list with statuses so the user can track progress.
"""

Syntax: strictly use parentheses with comma-separated arguments and equal signs for keyword args.
Example: my_tool(arg1=123, arg2="text"). Do NOT use colons.



You may call a python functions to execute an action.
To do so, you must wrap it in the following template:

<TOOL_CALL> function_name(arg_1=value1, arg2=value2, ...) </TOOL_CALL>

and it is wrapped as <TOOL_CALL> ... </TOOL_CALL>.
The call MUST begin with the sequence "<TOOL_CALL>" and MUST end with the sequence "</TOOL_CALL>" to be valid.
The inner content must be valid python code.

Here are your available functions:

def apply_unified_patch(		patch: string	 # Unified-diff text; use ```diff fenced blocks when authoring
)
"""
Apply a unified-diff patch (edits/additions/deletions) to files
"""

def TodoWrite(		todos: array	 # Ordered todo items. Include the entire list every time you update progress.
)
"""
Write or update the full todo checklist. Provide the entire ordered list with statuses so the user can track progress.
"""

Syntax: strictly use parentheses with comma-separated arguments and equal signs for keyword args.
Example: my_tool(arg1=123, arg2="text"). Do NOT use colons.



</FUNCTIONS>
END SYSTEM MESSAGE
