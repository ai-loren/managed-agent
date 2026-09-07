#!/usr/bin/env node
/**
 * Repository lint.
 *
 * Deliberately not ESLint. The rules worth enforcing here are project-specific
 * invariants that a general linter has no opinion about, and adding a plugin
 * ecosystem to a codebase whose selling point is a reviewable dependency tree
 * would be self-defeating. Formatting is not policed — reviewers should argue
 * about design, and nobody should argue about either.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['packages', 'apps'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'data', 'tmp']);

/** @type {{file: string, line: number, rule: string, message: string}[]} */
const problems = [];

/** Rules that apply to source files (not tests). */
const SOURCE_RULES = [
  {
    name: 'no-console',
    // The logger redacts secrets; console.log does not. A stray console.log in
    // a control plane is how a credential reaches stdout.
    test: /(?<![\w.])console\.(log|info|warn|error|debug)\s*\(/,
    message: 'use the injected Logger instead of console; console output bypasses redaction',
    exempt: (file) => file.includes('/cli/') || file.includes('/scripts/'),
  },
  {
    name: 'no-date-now',
    // Time must be injected so lease expiry and backoff are testable.
    test: /(?<![\w.])Date\.now\s*\(\)/,
    message: 'inject a Clock and call clock.now(); Date.now() is untestable',
    exempt: (file) => file.endsWith('/clock.ts'),
  },
  {
    name: 'no-bare-timers',
    test: /(?<![\w.])(setTimeout|setInterval)\s*\(/,
    message: 'use clock.sleep() or the scheduler; bare timers cannot be driven by tests',
    exempt: (file) => file.endsWith('/clock.ts'),
  },
  {
    name: 'no-any',
    test: /:\s*any(?![\w$])/,
    message: 'avoid `any`; use `unknown` and narrow, or declare the real type',
  },
  {
    name: 'no-ts-ignore',
    test: /@ts-ignore/,
    message: 'use @ts-expect-error with an adjacent comment explaining why',
  },
  {
    name: 'no-non-null-assertion-on-index',
    // `arr[i]!` defeats noUncheckedIndexedAccess, which we enabled on purpose.
    test: /\[\s*(i|index|idx)\s*\]!/,
    message: 'check the index result instead of asserting non-null',
    exempt: () => true, // advisory; enable once the codebase is clean
  },
];

/** Rules that apply to every TypeScript file including tests. */
const UNIVERSAL_RULES = [
  {
    name: 'no-focused-tests',
    test: /\b(test|describe)\.only\s*\(/,
    message: 'remove .only before committing; it silently skips the rest of the suite',
  },
  {
    name: 'no-parameter-properties',
    // Node runs TypeScript by *erasing* types, so syntax that emits code —
    // parameter properties, enums, namespaces — fails at load time. tsc accepts
    // it, which makes this a runtime-only failure the typechecker cannot catch.
    test: /constructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w+\s*:/,
    message: 'parameter properties emit code; declare the field and assign it in the constructor',
  },
  {
    name: 'no-enum',
    test: /^\s*(export\s+)?(const\s+)?enum\s+\w+/,
    message: 'enums emit code and cannot be erased; use a const array with a union type',
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') || entry.endsWith('.mjs')) yield full;
  }
}

/**
 * Strip line and block comments so a rule name in prose is not a violation.
 * Newlines are preserved so reported line numbers stay accurate.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_match, prefix) => prefix);
}

/**
 * Line numbers suppressed by a `ma-lint-disable-next-line <rule> -- <reason>`
 * comment. A reason is mandatory: an unexplained suppression is how a rule
 * quietly stops meaning anything.
 */
function suppressions(rawLines) {
  /** @type {Map<number, Set<string>>} */
  const map = new Map();
  for (let index = 0; index < rawLines.length; index++) {
    const match = /ma-lint-disable-next-line\s+([\w-]+)\s+--\s+\S/.exec(rawLines[index] ?? '');
    if (!match) continue;
    const target = index + 2; // 1-based, next line
    if (!map.has(target)) map.set(target, new Set());
    map.get(target).add(match[1]);
  }
  return map;
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    const rawLines = raw.split('\n');
    const source = stripComments(raw);
    const suppressed = suppressions(rawLines);
    const isTest = rel.includes('/test/') || rel.endsWith('.test.ts');
    const rules = isTest ? UNIVERSAL_RULES : [...SOURCE_RULES, ...UNIVERSAL_RULES];

    const lines = source.split('\n');
    for (const rule of rules) {
      if (rule.exempt?.(rel)) continue;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const lineNumber = index + 1;
        if (suppressed.get(lineNumber)?.has(rule.name)) continue;
        if (line && rule.test.test(line)) {
          problems.push({ file: rel, line: lineNumber, rule: rule.name, message: rule.message });
        }
      }
    }
  }
}

if (problems.length === 0) {
  process.stdout.write('lint: clean\n');
  process.exit(0);
}

for (const problem of problems) {
  process.stdout.write(`${problem.file}:${problem.line}  ${problem.rule}  ${problem.message}\n`);
}
process.stdout.write(`\nlint: ${problems.length} problem(s)\n`);
process.exit(1);
