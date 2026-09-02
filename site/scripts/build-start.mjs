/** Generate the remote agent bootstrap after the static site build. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const RELEASE_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function renderStart({ releaseCommit, version }) {
  if (!releaseCommit) {
    return `# Transmogrify is not published yet

Stop here. No installable public release has been configured for this site.
Do not clone a branch or substitute an unpinned revision.
`;
  }
  if (!RELEASE_COMMIT_RE.test(releaseCommit)) {
    throw new Error('TRANSMOGRIFY_RELEASE_COMMIT must be a lowercase 40- or 64-character Git object ID');
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('root package version must be a canonical semantic version');
  }

  return `# Start Transmogrify ${version}

Install and initialize Transmogrify for the Git repository containing the
current task. These instructions are for either a Codex or Claude Code host.
The executable source is pinned to Git commit \`${releaseCommit}\`; do not
replace it with a branch, tag, or different revision.

1. Before changing directories or creating scratch space, resolve and preserve
   the exact target repository root. Derive a collision-resistant private
   external worktree root for that repository and create every
   Transmogrify-owned directory with owner-only permissions:

   \`\`\`bash
   export REPO_ROOT="$(git rev-parse --show-toplevel)"
   export TRANSMOGRIFY_DATA_ROOT="$HOME/.local/share/transmogrify"
   install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT"
   install -d -m 700 "$TRANSMOGRIFY_DATA_ROOT/worktrees"
   export TRANSMOGRIFY_REPO_KEY="$(node -e 'const { createHash } = require("node:crypto"); process.stdout.write(createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$REPO_ROOT")"
   export WORKTREES="$TRANSMOGRIFY_DATA_ROOT/worktrees/$TRANSMOGRIFY_REPO_KEY"
   install -d -m 700 "$WORKTREES"
   \`\`\`

   Keep \`REPO_ROOT\` and \`WORKTREES\` unchanged for the rest of the workflow.
   Pass \`REPO_ROOT\` to repository-bound lifecycle calls. Pass \`WORKTREES\`
   when spawning a managed lane; later calls recover the exact seat from its
   durable lane record.
2. Create a fresh scratch directory outside the target repository, fetch only
   the pinned release commit, and verify the checked-out object and version:

   \`\`\`bash
   export TRANSMOGRIFY_RELEASE_COMMIT=${releaseCommit}
   export TRANSMOGRIFY_RELEASE_VERSION=${version}
   export TRANSMOGRIFY_SCRATCH="$(mktemp -d)"
   cleanup_transmogrify_scratch() {
     test -n "\${TRANSMOGRIFY_SCRATCH:-}" && rm -rf -- "$TRANSMOGRIFY_SCRATCH"
   }
   trap cleanup_transmogrify_scratch EXIT HUP INT TERM
   git -C "$TRANSMOGRIFY_SCRATCH" init
   git -C "$TRANSMOGRIFY_SCRATCH" remote add origin https://github.com/nicholasgerard/transmogrify.git
   git -C "$TRANSMOGRIFY_SCRATCH" fetch --depth 1 origin "$TRANSMOGRIFY_RELEASE_COMMIT"
   git -C "$TRANSMOGRIFY_SCRATCH" checkout --detach FETCH_HEAD
   test "$(git -C "$TRANSMOGRIFY_SCRATCH" rev-parse HEAD)" = "$TRANSMOGRIFY_RELEASE_COMMIT"
   test "$(node -p 'require(process.argv[1]).version' "$TRANSMOGRIFY_SCRATCH/package.json")" = "$TRANSMOGRIFY_RELEASE_VERSION"
   \`\`\`

   Report the verified version and commit before installation. If either check
   fails, stop; never fall back to the repository default branch.
3. Select exactly one current-host profile. A Codex host uses:

   \`\`\`bash
   export TRANSMOGRIFY_INSTALL_TARGET=codex
   export TRANSMOGRIFY_HOST_PROVIDER=codex
   export TRANSMOGRIFY_HOST_APP=codex-desktop
   export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
   \`\`\`

   A Claude Code host uses:

   \`\`\`bash
   export TRANSMOGRIFY_INSTALL_TARGET=claude
   export TRANSMOGRIFY_HOST_PROVIDER=claude
   export TRANSMOGRIFY_HOST_APP=claude-desktop
   export SKILL_ROOT="$HOME/.claude/skills/transmogrify"
   \`\`\`

   Do not select a provider merely because its desktop app is installed. Install
   dependencies and run the installer by absolute path inside the verified
   scratch checkout, then remove that checkout:

   \`\`\`bash
   npm --prefix "$TRANSMOGRIFY_SCRATCH" ci --ignore-scripts
   "$TRANSMOGRIFY_SCRATCH/install.sh" --target "$TRANSMOGRIFY_INSTALL_TARGET" --dry-run
   "$TRANSMOGRIFY_SCRATCH/install.sh" --target "$TRANSMOGRIFY_INSTALL_TARGET"
   cleanup_transmogrify_scratch
   trap - EXIT HUP INT TERM
   unset -f cleanup_transmogrify_scratch
   unset TRANSMOGRIFY_SCRATCH
   \`\`\`

   Do not replace an unrelated occupied skill directory. On a deliberately
   dual-host machine, update the other host only after this current-host check
   passes; \`--target all\` is the explicit dual-install option.
4. Open and follow the installed \`SKILL.md\` completely. Treat its ownership,
   runtime, worktree, receipt, and recovery rules as the operating contract.
   Use the external \`WORKTREES\` root established above instead of the
   inside-repository default.
5. Choose target providers independently from the host installation. For
   turnkey bidirectional operation on a compatible Apple Silicon macOS host,
   inspect both. A deliberately single-provider host may select only the target
   it can satisfy:

   \`\`\`bash
   export TRANSMOGRIFY_DOCTOR_TARGET=all  # or: codex | claude
   \`\`\`

   Use the selected installation as the command root, then run the read-only
   doctor against the target repository and selected providers:

   \`\`\`bash
   node "$SKILL_ROOT/scripts/doctor.js" \\
     --repo-root "$REPO_ROOT" \\
     --target "$TRANSMOGRIFY_DOCTOR_TARGET"
   \`\`\`

6. Reuse a compatible runtime that the doctor verifies. Never kill, restart,
   reconfigure, steer, interrupt, archive, or adopt a runtime or lane that this
   Transmogrify installation does not exactly own. If no compatible Codex
   runtime is available, ask before starting one.
7. Reconcile only exact-owned pending operations. Before the first managed
   spawn, create or recover the current task's durable parent context with
   \`TRANSMOGRIFY_HOST_PROVIDER\` and \`TRANSMOGRIFY_HOST_APP\` as specified in
   \`SKILL.md\`; pass its absolute context file to every spawn and
   remain in the documented bounded wait/acknowledgement loop until all of its
   children are handled. Report the doctor result and any release-gate
   limitation, then continue with the user's requested work through the
   installed skill.

Transmogrify does not use GUI automation as a lifecycle control channel.
`;
}

if (import.meta.filename === process.argv[1]) {
  const rootPackage = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  const output = renderStart({
    releaseCommit: (process.env.TRANSMOGRIFY_RELEASE_COMMIT ?? '').trim(),
    version: rootPackage.version,
  });
  const target = resolve(process.argv[2] ?? 'dist/start');
  await writeFile(target, output, 'utf8');
  console.log(
    process.env.TRANSMOGRIFY_RELEASE_COMMIT
      ? 'wrote commit-pinned dist/start'
      : 'wrote disabled pre-release dist/start',
  );
}
