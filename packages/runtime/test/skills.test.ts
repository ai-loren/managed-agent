/**
 * Skill parsing and instruction formatting.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseSkillManifest, formatSkillInstructions } from '../src/skills.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('skill manifest parsing', () => {
  test('reads frontmatter and keeps the instruction body', () => {
    const parsed = parseSkillManifest(
      bytes('---\nname: greeter\ndescription: Greets warmly\nversion: 1.0.0\n---\nAlways greet in French.'),
    );
    assert.equal(parsed.manifest.name, 'greeter');
    assert.equal(parsed.manifest.description, 'Greets warmly');
    assert.equal(parsed.manifest.version, '1.0.0');
    assert.equal(parsed.body, 'Always greet in French.');
  });

  test('falls back to the supplied name when frontmatter omits it', () => {
    const parsed = parseSkillManifest(bytes('Just instructions, no frontmatter.'), 'from-ref');
    assert.equal(parsed.manifest.name, 'from-ref');
    assert.equal(parsed.body, 'Just instructions, no frontmatter.');
  });

  test('parses a comma-separated tools list', () => {
    const parsed = parseSkillManifest(bytes('---\nname: kit\ntools: build, deploy\n---\nbody'));
    assert.deepEqual(parsed.manifest.tools, ['build', 'deploy']);
  });
});

describe('skill instruction formatting', () => {
  test('is empty when no skills are installed', () => {
    assert.equal(formatSkillInstructions([]), '');
  });

  test('advertises each skill by name and body under one section', () => {
    const out = formatSkillInstructions([
      { manifest: { name: 'greeter', description: 'Greets', version: '', tools: [] }, body: 'Greet in French.' },
    ]);
    assert.match(out, /# Installed skills/);
    assert.match(out, /## Skill: greeter/);
    assert.match(out, /Greet in French\./);
  });

  test('truncates an over-long body with a visible marker', () => {
    const huge = 'x'.repeat(20_000);
    const out = formatSkillInstructions([
      { manifest: { name: 'big', description: '', version: '', tools: [] }, body: huge },
    ]);
    assert.match(out, /skill instructions truncated/);
    assert.ok(out.length < huge.length, 'the body was bounded');
  });
});
