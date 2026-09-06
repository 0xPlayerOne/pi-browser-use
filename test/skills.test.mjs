import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const skillsDir = join(import.meta.dirname, '..', 'skills');

describe('skills', () => {
  it('every skill has a parseable SKILL.md frontmatter', () => {
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.ok(skills.length > 0, 'expected bundled skills');
    for (const skill of skills) {
      const raw = readFileSync(join(skillsDir, skill, 'SKILL.md'), 'utf8');
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(match, `${skill}/SKILL.md is missing YAML frontmatter`);
      const frontmatter = match[1];
      const name = frontmatter.match(/^name: (.+)$/m)?.[1]?.trim();
      assert.equal(name, skill, `${skill}/SKILL.md name must match its directory`);
      // Descriptions must be double-quoted: an unquoted ": " inside the text
      // is a YAML nested-mapping error in Pi ("Nested mappings are not
      // allowed in compact mappings").
      const description = frontmatter.match(/^description: (.+)$/m)?.[1]?.trim();
      assert.ok(description?.startsWith('"') && description?.endsWith('"'), `${skill}/SKILL.md description must be double-quoted`);
      assert.ok((description?.length ?? 0) > 20, `${skill}/SKILL.md description looks empty`);
    }
  });
});
