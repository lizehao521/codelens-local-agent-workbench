/**
 * Import DSH skills from skills/dsh/ into the skill library.
 *
 * Usage: node --import tsx scripts/import-dsh-skills.ts
 * (run from server/ directory)
 */

import { createDb } from '../src/repositories/db.js';
import { SkillLibraryService } from '../src/services/skills/skill-library.service.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// 权威源在仓库根 skills/dsh/；server/skills/dsh/ 是沙箱镜像副本，仅在根路径不可达时回退。
const DSH_ROOT = existsSync(join(ROOT, '..', 'skills', 'dsh', 'manifest.json'))
  ? join(ROOT, '..', 'skills', 'dsh')
  : join(ROOT, 'skills', 'dsh');
const SKILLS_DIR = join(DSH_ROOT, 'skills');
const MANIFEST_PATH = join(DSH_ROOT, 'manifest.json');
const DB_PATH = join(ROOT, 'data', 'codelens.db');

interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: {
    tags?: string[];
    triggers?: string[];
  };
}

function parseSkillFile(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  // Strip UTF-8 BOM (EF BB BF) if present
  const stripped = content.replace(/^\uFEFF/, '');
  const frontmatterMatch = stripped.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    console.warn('  ⚠ No frontmatter found, skipping');
    return null;
  }

  const frontmatterText = frontmatterMatch[1];
  const body = content.slice(frontmatterMatch[0].length).trim();

  // Simple YAML-like parsing for our known fields
  const frontmatter: SkillFrontmatter = {
    name: '',
    description: '',
    metadata: {},
  };

  let currentKey = '';
  let inMetadata = false;
  let metadataObj: Record<string, string[]> = {};

  for (const line of frontmatterText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed === 'metadata:') {
      inMetadata = true;
      continue;
    }

    if (inMetadata) {
      const metaMatch = trimmed.match(/^(\w+):\s*\[(.*)\]/);
      if (metaMatch) {
        const key = metaMatch[1];
        const values = metaMatch[2].split(',').map(v => v.trim().replace(/['"]/g, ''));
        metadataObj[key] = values;
      }
      continue;
    }

    const match = trimmed.match(/^(\w+):\s*(.*)/);
    if (match) {
      currentKey = match[1];
      const value = match[2].replace(/^['"]|['"]$/g, '').trim();
      if (currentKey === 'name') frontmatter.name = value;
      else if (currentKey === 'description') frontmatter.description = value;
    }
  }

  frontmatter.metadata = {
    tags: metadataObj.tags || [],
    triggers: metadataObj.triggers || [],
  };

  return { frontmatter, body };
}

function extractSteps(body: string): string[] {
  // Extract steps from the "执行流程" section
  const steps: string[] = [];
  const lines = body.split('\n');
  let inExecutionFlow = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## 执行流程') || trimmed.startsWith('## Execution Flow')) {
      inExecutionFlow = true;
      continue;
    }
    if (inExecutionFlow && trimmed.startsWith('## ')) {
      break; // Next section
    }
    if (inExecutionFlow) {
      // Match numbered steps: "1. **Step name** —— description"
      const stepMatch = trimmed.match(/^\d+\.\s*\*\*(.+?)\*\*\s*[——\-–]\s*(.+)$/);
      if (stepMatch) {
        steps.push(`${stepMatch[1]}: ${stepMatch[2]}`);
      } else {
        // Match simple numbered steps: "1. description"
        const simpleMatch = trimmed.match(/^\d+\.\s+(.+)$/);
        if (simpleMatch) {
          steps.push(simpleMatch[1]);
        }
      }
    }
  }

  // Fallback: if no steps found, try to extract from any numbered list
  if (steps.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^\d+\.\s+(.+)$/);
      if (match) {
        steps.push(match[1]);
      }
    }
  }

  return steps.slice(0, 12); // Respect maxSteps limit
}

async function main() {
  console.log('📦 Importing DSH skills...\n');

  // Read manifest
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const skillNames = manifest.skills as string[];
  console.log(`Manifest lists ${skillNames.length} skills`);

  // Initialize DB and skill library
  const db = createDb(DB_PATH);
  const skillLibrary = new SkillLibraryService({
    db,
    enabled: true,
    matchMinScore: 0.15,
    maxSteps: 12,
  });

  if (!skillLibrary.enabled) {
    console.error('❌ Skill library is disabled. Set SKILL_LIBRARY_ENABLED=true');
    process.exit(1);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const skillName of skillNames) {
    const skillDir = join(SKILLS_DIR, skillName);
    const skillFile = join(skillDir, 'SKILL.md');

    try {
      if (!statSync(skillFile).isFile()) {
        console.warn(`  ⚠ ${skillName}: SKILL.md not found`);
        errors++;
        continue;
      }

      const content = readFileSync(skillFile, 'utf-8');
      const parsed = parseSkillFile(content);

      if (!parsed) {
        console.warn(`  ⚠ ${skillName}: Failed to parse frontmatter`);
        errors++;
        continue;
      }

      const { frontmatter, body } = parsed;
      const steps = extractSteps(body);

      if (steps.length === 0) {
        console.warn(`  ⚠ ${skillName}: No steps extracted from body`);
        errors++;
        continue;
      }

      // Combine tags and triggers
      const tags = [
        ...new Set([
          ...(frontmatter.metadata?.tags || []),
          ...(frontmatter.metadata?.triggers || []),
        ]),
      ].slice(0, 16); // Respect tag count limit

      // Check if already exists
      const existing = skillLibrary.get(frontmatter.name);
      if (existing) {
        console.log(`  ⏭ ${frontmatter.name} (already exists)`);
        skipped++;
        continue;
      }

      // Create skill
      skillLibrary.create({
        name: frontmatter.name,
        description: frontmatter.description,
        tags,
        steps,
        matchScore: 0.7,
      });

      console.log(`  ✅ ${frontmatter.name} (${steps.length} steps, ${tags.length} tags)`);
      imported++;
    } catch (err) {
      if (err instanceof Error && err.message.includes('SKILL_ALREADY_EXISTS')) {
        console.log(`  ⏭ ${skillName} (already exists)`);
        skipped++;
      } else if (err instanceof Error && err.message.includes('SKILL_LIBRARY_DISABLED')) {
        console.error('❌ Skill library is disabled');
        process.exit(1);
      } else if (err instanceof Error && err.message.includes('SKILL_SECRET_DETECTED')) {
        console.warn(`  🔒 ${skillName}: Rejected (secret detected)`);
        errors++;
      } else {
        console.error(`  ❌ ${skillName}: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
      }
    }
  }

  console.log(`\n📊 Summary: ${imported} imported, ${skipped} skipped, ${errors} errors`);

  // Verify by listing
  const allSkills = skillLibrary.list();
  console.log(`\n📚 Total skills in library: ${allSkills.length}`);
  for (const skill of allSkills.slice(0, 10)) {
    console.log(`  - ${skill.name}: ${skill.description.slice(0, 60)}...`);
  }
  if (allSkills.length > 10) {
    console.log(`  ... and ${allSkills.length - 10} more`);
  }

  db.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});