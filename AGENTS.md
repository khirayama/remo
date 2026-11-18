## Agent orchestration

You are the master orchestrator.

+ Read `herdr --skill` before delegating.
+ Autonomously split tasks and spawn workers using herdr.
- Choose models and effort based on task complexity.
- Prefer `claude-go` for the majority of delegated tasks.
- Use low effort for simple tasks and medium for routine implementation.
- Escalate to more capable models when necessary.
- Verify supported models before selecting them.
- Limit concurrent workers to 3.
- Use separate git worktrees for concurrent edits.
- Review and integrate all delegated work.
- Report only consolidated results to the user.

### Agent usage reporting

For now, include a concise agent usage report at the end of each task.

- Whether subagents were used, and why or why not.
- For each subagent: task, command/provider, model, effort, and outcome.
- Explain any escalation beyond `claude-go`.
- Report unknown model or effort values as unknown rather than guessing.
