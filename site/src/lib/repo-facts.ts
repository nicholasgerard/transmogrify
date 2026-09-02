/**
 * Build-time extraction of facts that already have a canonical home in the
 * repository root. Nothing in this file invents a value: every field is parsed
 * out of `README.md`, `SKILL.md`, or the root `package.json`, and every parser
 * throws when its anchor is missing so that documentation drift fails the build
 * instead of silently shipping a stale website.
 *
 * The pure parsers are exported separately from the filesystem reads so they
 * can be unit tested without touching disk.
 */

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

export interface SupportMatrix extends MarkdownTable {
  /** Prose immediately following the table in README.md. */
  notes: string;
}

export interface CompatibilityPins {
  version: string;
  verifiedDate: string;
  verifiedCodexRuntime: string;
  supportedCodexRuntime: string;
  verifiedCodexDesktop: string;
  verifiedCodexMobile: string;
  verifiedClaudeCli: string;
  verifiedClaudeDesktop: string;
  verifiedClaudeMobile: string;
}

export interface RepoFacts {
  /** Version declared by the root package.json. */
  packageVersion: string;
  /** Canonical GitHub repository URL, derived from the root package.json. */
  repositoryUrl: string;
  /** GitHub issues URL, derived from the root package.json. */
  issuesUrl: string;
  /** Minimum Node.js major version declared by the root package.json. */
  nodeEngine: string;
  /** Sole runtime dependency name(s) declared by the root package.json. */
  runtimeDependencies: string[];
  pins: CompatibilityPins;
  supportMatrix: SupportMatrix;
}

const CELL_SPLIT = /(?<!\\)\|/;

/** Split one GitHub-flavoured Markdown table row into trimmed cells. */
export function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(CELL_SPLIT).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

/**
 * Read the first Markdown table that appears under the given ATX heading.
 * Throws when the heading or the table is absent.
 */
export function parseMarkdownTableUnderHeading(
  markdown: string,
  heading: string,
): MarkdownTable & { trailingProse: string } {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex(
    (line) => line.trim().replace(/^#+\s*/, '').toLowerCase() === heading.toLowerCase() && /^#+\s/.test(line),
  );
  if (headingIndex === -1) {
    throw new Error(`Heading "${heading}" not found; the site cannot render a fact it cannot locate.`);
  }

  let cursor = headingIndex + 1;
  while (cursor < lines.length && !lines[cursor]!.trim().startsWith('|')) {
    if (/^#+\s/.test(lines[cursor]!)) {
      throw new Error(`No Markdown table between "${heading}" and the next heading.`);
    }
    cursor += 1;
  }
  if (cursor >= lines.length) {
    throw new Error(`No Markdown table found under "${heading}".`);
  }

  const headers = parseTableRow(lines[cursor]!);
  cursor += 1;
  if (cursor >= lines.length || !isDelimiterRow(lines[cursor]!)) {
    throw new Error(`Table under "${heading}" is missing its delimiter row.`);
  }
  cursor += 1;

  const rows: string[][] = [];
  while (cursor < lines.length && lines[cursor]!.trim().startsWith('|')) {
    const cells = parseTableRow(lines[cursor]!);
    if (cells.length !== headers.length) {
      throw new Error(
        `Table under "${heading}" has a row with ${cells.length} cells but ${headers.length} headers.`,
      );
    }
    rows.push(cells);
    cursor += 1;
  }
  if (rows.length === 0) {
    throw new Error(`Table under "${heading}" has no data rows.`);
  }

  const prose: string[] = [];
  while (cursor < lines.length && !/^#+\s/.test(lines[cursor]!)) {
    prose.push(lines[cursor]!);
    cursor += 1;
  }

  return { headers, rows, trailingProse: prose.join('\n').trim() };
}

/**
 * Read a flat `key: value` block from the `metadata:` map of a YAML
 * frontmatter fence. Deliberately minimal: SKILL.md's metadata block is a flat
 * map of quoted scalars, and a full YAML parser would be a dependency this site
 * does not need.
 */
export function parseSkillMetadata(markdown: string): Record<string, string> {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(markdown);
  if (!fence) {
    throw new Error('SKILL.md has no YAML frontmatter fence.');
  }
  const lines = fence[1]!.split(/\r?\n/);
  const start = lines.findIndex((line) => /^metadata:\s*$/.test(line));
  if (start === -1) {
    throw new Error('SKILL.md frontmatter has no `metadata:` block.');
  }

  const metadata: Record<string, string> = {};
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') continue;
    if (!/^\s+\S/.test(line)) break;
    const match = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    metadata[match[1]!] = match[2]!.replace(/^["'](.*)["']$/, '$1');
  }
  if (Object.keys(metadata).length === 0) {
    throw new Error('SKILL.md `metadata:` block is empty.');
  }
  return metadata;
}

function requireKey(map: Record<string, string>, key: string): string {
  const value = map[key];
  if (!value) {
    throw new Error(`SKILL.md metadata is missing "${key}".`);
  }
  return value;
}

export function buildCompatibilityPins(
  metadata: Record<string, string>,
): CompatibilityPins {
  return {
    version: requireKey(metadata, 'version'),
    verifiedDate: requireKey(metadata, 'verified_date'),
    verifiedCodexRuntime: requireKey(metadata, 'verified_codex_runtime'),
    supportedCodexRuntime: requireKey(metadata, 'supported_codex_runtime'),
    verifiedCodexDesktop: requireKey(metadata, 'verified_codex_desktop'),
    verifiedCodexMobile: requireKey(metadata, 'verified_codex_mobile'),
    verifiedClaudeCli: requireKey(metadata, 'verified_claude_cli'),
    verifiedClaudeDesktop: requireKey(metadata, 'verified_claude_desktop'),
    verifiedClaudeMobile: requireKey(metadata, 'verified_claude_mobile'),
  };
}

/** Turn `git+https://github.com/owner/name.git` into `https://github.com/owner/name`. */
export function normalizeRepositoryUrl(raw: string): string {
  const cleaned = raw
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(cleaned)) {
    throw new Error(`Unexpected repository URL shape: ${raw}`);
  }
  return cleaned;
}

/** Turn `>=20` into `20`. */
export function normalizeNodeEngine(raw: string): string {
  const match = /(\d+)/.exec(raw);
  if (!match) {
    throw new Error(`Unexpected Node engine range: ${raw}`);
  }
  return match[1]!;
}

interface RootPackageJson {
  version?: string;
  repository?: { url?: string };
  bugs?: { url?: string };
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

export function buildRepoFacts(inputs: {
  readme: string;
  skill: string;
  rootPackageJson: RootPackageJson;
}): RepoFacts {
  const { readme, skill, rootPackageJson } = inputs;

  const matrix = parseMarkdownTableUnderHeading(readme, 'Support matrix');
  const pins = buildCompatibilityPins(parseSkillMetadata(skill));

  if (!rootPackageJson.version) throw new Error('Root package.json has no version.');
  if (!rootPackageJson.repository?.url) throw new Error('Root package.json has no repository.url.');
  if (!rootPackageJson.bugs?.url) throw new Error('Root package.json has no bugs.url.');
  if (!rootPackageJson.engines?.node) throw new Error('Root package.json has no engines.node.');

  const runtimeDependencies = Object.keys(rootPackageJson.dependencies ?? {});
  if (runtimeDependencies.length === 0) {
    throw new Error('Root package.json declares no runtime dependencies.');
  }

  return {
    packageVersion: rootPackageJson.version,
    repositoryUrl: normalizeRepositoryUrl(rootPackageJson.repository.url),
    issuesUrl: rootPackageJson.bugs.url,
    nodeEngine: normalizeNodeEngine(rootPackageJson.engines.node),
    runtimeDependencies,
    pins,
    supportMatrix: {
      headers: matrix.headers,
      rows: matrix.rows,
      notes: matrix.trailingProse,
    },
  };
}
