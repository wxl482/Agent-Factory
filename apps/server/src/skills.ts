import fs from 'node:fs';
import path from 'node:path';
import type { RoleDef } from '@af/shared';
import { config } from './config.js';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  body: string;
}

const cache = new Map<string, { mtime: number; skill: SkillMeta }>();

function parseSkill(id: string, raw: string): SkillMeta {
  let name = id;
  let description = '';
  let body = raw.trim();
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (fm) {
    body = fm[2].trim();
    for (const line of fm[1].split('\n')) {
      const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'name') name = m[2].replace(/^['"]|['"]$/g, '').trim();
      if (m[1] === 'description') description = m[2].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return { id, name, description, body };
}

export function getSkill(id: string): SkillMeta | null {
  const file = path.join(config.skillsDir, id, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  try {
    const st = fs.statSync(file);
    const hit = cache.get(id);
    if (hit && hit.mtime === st.mtimeMs) return hit.skill;
    const skill = parseSkill(id, fs.readFileSync(file, 'utf8'));
    cache.set(id, { mtime: st.mtimeMs, skill });
    return skill;
  } catch {
    return null;
  }
}

export function listSkills(): { id: string; name: string; description: string }[] {
  if (!fs.existsSync(config.skillsDir)) return [];
  const out: { id: string; name: string; description: string }[] = [];
  for (const e of fs.readdirSync(config.skillsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const s = getSkill(e.name);
    if (s) out.push({ id: s.id, name: s.name, description: s.description });
  }
  return out;
}

export function buildRoleSkillsPrompt(role: RoleDef): string {
  if (!role.skills?.length) return '';
  const blocks: string[] = [];
  for (const id of role.skills) {
    const s = getSkill(id);
    if (s) blocks.push(`### [${s.name}]\n${s.body}`);
  }
  return blocks.length ? `\n\n## 岗位专项技能包 (SOP)\n${blocks.join('\n\n')}` : '';
}
