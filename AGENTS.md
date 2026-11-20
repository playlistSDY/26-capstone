# Commit message rules

Follow these rules for every Git commit in this project.

- Use `type(scope): Subject`; the scope is optional.
- Choose the lowercase type from `feat`, `fix`, `build`, `chore`, `ci`,
  `docs`, `style`, `refactor`, `test`, or `perf`.
- Keep the full header within 50 characters. Capitalize the first letter
  of an English subject, use an imperative subject, and omit its final period.
- Separate the header, optional body, and optional footer with a blank line.
- Keep body lines within 72 characters. Explain what changed and why.
- Put issue references in the optional footer, such as `Resolves: #123`.
- Check these requirements before committing and preserve unrelated work.

# Repository workflow

- Track source code, required local assets, hardware designs, tests, and docs.
- Keep generated releases, runtimes, dependency installations, local data,
  credentials, and transient test results out of Git.
- Commit completed, relevant work locally. Do not push or create a remote
  repository without the user's instruction.
