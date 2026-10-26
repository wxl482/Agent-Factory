import fs from 'node:fs';
import path from 'node:path';
import type { CompanyProfile, RoleDef } from '@af/shared';
import { config } from './config.js';

/** 公司配置：业务模块可插拔，在 company/profiles/ 下新增 JSON 即可新增一种公司 */
class Company {
  profile!: CompanyProfile;

  list() {
    return fs
      .readdirSync(config.profilesDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = JSON.parse(fs.readFileSync(path.join(config.profilesDir, f), 'utf8')) as CompanyProfile;
        return { id: p.id, name: p.name };
      });
  }

  load(id: string) {
    const file = path.join(config.profilesDir, `${id}.json`);
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as CompanyProfile;
    if (!p.roles.some((r) => r.id === p.managerRoleId)) throw new Error(`配置 ${id} 缺少经理角色 ${p.managerRoleId}`);
    if (!p.agents.some((a) => a.roleId === p.managerRoleId)) throw new Error(`配置 ${id} 没有经理员工`);
    for (const a of p.agents) if (!p.roles.some((r) => r.id === a.roleId)) throw new Error(`员工 ${a.id} 的角色 ${a.roleId} 不存在`);
    this.profile = p;
    return p;
  }

  role(id: string): RoleDef {
    return this.profile.roles.find((r) => r.id === id)!;
  }

  roleName(id: string) {
    return this.profile.roles.find((r) => r.id === id)?.name ?? id;
  }

  agentName(id: string) {
    if (id === 'human') return '老板';
    return this.profile.agents.find((a) => a.id === id)?.name ?? id;
  }

  managerAgentId() {
    return this.profile.agents.find((a) => a.roleId === this.profile.managerRoleId)!.id;
  }

  isManager(agentId: string) {
    return this.profile.agents.find((a) => a.id === agentId)?.roleId === this.profile.managerRoleId;
  }

  workerRoles() {
    return this.profile.roles.filter((r) => r.id !== this.profile.managerRoleId);
  }
}

export const company = new Company();
