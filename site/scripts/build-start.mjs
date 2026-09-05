/** Generate the remote agent bootstrap after the static site build. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import setupPlan from '../../scripts/lib/setup-plan.js';

const { IDE_CONTEXT, TERMINAL_CONTEXT, UNSUPPORTED_CONTEXT } = setupPlan;

export const RELEASE_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const PREREQUISITE_BLOCK = `command -v git >/dev/null 2>&1 || {
  printf '%s\\n' 'Transmogrify needs Git. Install Git, then start again.' >&2
  exit 1
}
command -v node >/dev/null 2>&1 || {
  printf '%s\\n' 'Transmogrify needs Node.js 20 or newer. Install it, then start again.' >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf '%s\\n' 'Transmogrify needs npm. Install it, then start again.' >&2
  exit 1
}
node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(Number.isSafeInteger(major) && major >= 20 ? 0 : 1)' || {
  printf '%s\\n' 'Transmogrify needs Node.js 20 or newer. Upgrade Node.js, then start again.' >&2
  exit 1
}
git rev-parse --verify HEAD >/dev/null || {
  printf '%s\\n' 'Open a Git repository with at least one commit, then start again.' >&2
  exit 1
}
REPO_ROOT="$(git rev-parse --show-toplevel)" || {
  printf '%s\\n' 'The repository root could not be resolved. Fix Git, then start again.' >&2
  exit 1
}
test -n "$REPO_ROOT" || {
  printf '%s\\n' 'The repository root was empty. Fix Git, then start again.' >&2
  exit 1
}
export REPO_ROOT`;

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

1. Check every prerequisite before changing directories, invoking the
   installer, or creating anything. Git, Node.js, and npm must be available.
   Node.js must be version 20 or newer. The current directory must be inside a
   Git repository that already has a commit. Resolve the repository root before
   exporting it, so a failure cannot be hidden:

   \`\`\`bash
${PREREQUISITE_BLOCK.split('\n').map((line) => `   ${line}`).join('\n')}
   \`\`\`

   Stop if any prerequisite fails. Do not begin preparation or substitute a
   different repository.
2. Derive a collision-resistant private external worktree root for that
   repository. Create every Transmogrify-owned directory with owner-only
   permissions:

   \`\`\`bash
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
3. Create a fresh scratch directory outside the target repository, fetch only
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
4. Install for both Claude and Codex. Install dependencies and preview the
   change before running the installer by absolute path inside the verified
   scratch checkout:

   \`\`\`bash
   npm --prefix "$TRANSMOGRIFY_SCRATCH" ci --ignore-scripts
   "$TRANSMOGRIFY_SCRATCH/install.sh" --dry-run
   "$TRANSMOGRIFY_SCRATCH/install.sh"
   cleanup_transmogrify_scratch
   trap - EXIT HUP INT TERM
   unset -f cleanup_transmogrify_scratch
   unset TRANSMOGRIFY_SCRATCH
   \`\`\`

   Do not pass a host-selection option. The default installs both copies so a
   new session in either desktop app can use the same setup. Do not replace an
   unrelated occupied skill directory.
5. Use either installed copy as the command root, then open and follow its
   \`SKILL.md\` completely. Use the external \`WORKTREES\` root established
   above instead of the inside-repository default.

   \`\`\`bash
   export SKILL_ROOT="$HOME/.agents/skills/transmogrify"
   test -f "$SKILL_ROOT/SKILL.md" || export SKILL_ROOT="$HOME/.claude/skills/transmogrify"
   \`\`\`
6. Run the read-only explaining doctor for both hosts before describing the
   machine or asking the user for anything:

   \`\`\`bash
   node "$SKILL_ROOT/scripts/doctor.js" \\
     --repo-root "$REPO_ROOT" \\
     --target all \\
     --explain
   \`\`\`

7. Read the doctor's setup plan, but do not paste its JSON into the
   conversation. If its context sentence is present, say it exactly. The
   expected context sentences are:

   - Terminal: "${TERMINAL_CONTEXT}"
   - IDE agent: "${IDE_CONTEXT}"
   - Unsupported machine: "${UNSUPPORTED_CONTEXT}"

   Then give one short block in this order: what was found, what is ready,
   what is needed and why, and what happens next. Use plain words. Keep
   identifiers, file paths, ports, command names, and error codes out of the
   conversation unless the user asks for them.
8. Work through the plan's first remaining step only. State what the step does
   and why it is needed. If it needs consent, ask one yes-or-no question and
   wait. Never ask permission for a step the plan already shows cannot work.
   After consent, run \`setup.js\` with only the matching permission for that
   first step:

   \`\`\`bash
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-claude-cli
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --install-codex-cli
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --sign-in
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --start-runtime
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --relaunch-desktop
   node "$SKILL_ROOT/scripts/setup.js" --repo-root "$REPO_ROOT" --persist-attach
   \`\`\`

   Those are alternatives, not a batch. Run only the line that matches the
   current first step. For a step that needs no consent, run \`setup.js\`
   without a permission option. After each result, rerun the explaining doctor,
   give the short status block again, and handle only the new first step. Do
   not pre-authorize later steps. If the user declines, explain what remains
   available and stop asking about that step.
9. When setup is ready, follow the installed skill's ownership and safety
   rules. Reuse what the doctor found. Never kill, restart, reconfigure, steer,
   interrupt, archive, or adopt work that this installation does not own. In an
   IDE agent, finish setup and send the user to one of the desktop apps; do not
   start lane work there. On an unsupported machine, offer Codex without live
   app streaming. Otherwise continue with the user's requested work.

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
