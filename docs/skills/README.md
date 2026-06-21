# EightForge Codex Skill Reference Copies

This directory preserves durable, version-controlled reference copies of Codex skills used in EightForge development:

- `contract-rate-assembler-review`
- `eightforge-extraction-trace-debugger`
- `eightforge-validation-triage`

These copies are for source control and review. Live Codex invocation currently uses the user-level skill directories, such as `C:\Users\ADMS Thompson\.codex\skills\`, not this repository path.

The conventional repo-scoped Codex skill discovery location, `.agents/skills`, is currently a dangling and unconfigured gitlink. Its target commit `6c7e60f4...` is unreachable in this environment, the repository has no `.gitmodules`, and no remote is configured for that gitlink. Prior sessions documented this as intentional-but-unfinished external shared-skills-repo tooling.

This `docs/skills/` location exists so the skill content itself is not lost or machine-bound while a future decision remains open about properly configuring an external skills repository. Do not rely on Codex automatic discovery from this path. To actually use these skills, copy or sync them to the appropriate user-level skills directory or to a properly configured skills repository.
