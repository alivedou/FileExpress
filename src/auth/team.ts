export interface Team { id: string; name: string; parentId?: string; domain?: string; quotaBytes: number; usedBytes: number; branding: { name: string; color: string; logoUrl?: string } }
export interface TeamMember { teamId: string; userId: string; roles: string[] }

export class TeamService {
  private readonly teams = new Map<string, Team>();
  private readonly members = new Map<string, TeamMember[]>();
  private readonly domains = new Map<string, string>();

  create(input: Omit<Team, "usedBytes">): Team {
    if (this.teams.has(input.id)) throw new Error("Team already exists");
    if (input.quotaBytes < 0 || !Number.isSafeInteger(input.quotaBytes)) throw new Error("Invalid team quota");
    if (input.parentId) {
      if (!this.teams.has(input.parentId)) throw new Error("Parent team does not exist");
      if (this.effectiveQuota(input.parentId) < input.quotaBytes) throw new Error("Child quota exceeds inherited quota");
    }
    if (input.domain) {
      const domain = normaliseDomain(input.domain);
      if (this.domains.has(domain)) throw new Error("Domain is already bound");
      this.domains.set(domain, input.id);
      input = { ...input, domain };
    }
    const team = { ...input, usedBytes: 0, branding: { ...input.branding } };
    this.teams.set(team.id, team);
    return structuredClone(team);
  }
  move(teamId: string, parentId?: string): void {
    const team = this.require(teamId);
    if (parentId) {
      this.require(parentId);
      for (let current: string | undefined = parentId; current; current = this.teams.get(current)?.parentId) if (current === teamId) throw new Error("Team hierarchy cycle detected");
    }
    team.parentId = parentId;
  }
  addMember(member: TeamMember): void {
    this.require(member.teamId);
    const list = this.members.get(member.teamId) ?? [];
    const existing = list.find((item) => item.userId === member.userId);
    if (existing) existing.roles = [...new Set(member.roles)];
    else list.push({ ...member, roles: [...new Set(member.roles)] });
    this.members.set(member.teamId, list);
  }
  membersOf(teamId: string): TeamMember[] { return (this.members.get(teamId) ?? []).map((member) => ({ ...member, roles: [...member.roles] })); }
  consumeQuota(teamId: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage delta");
    for (let current: string | undefined = teamId; current; current = this.teams.get(current)?.parentId) {
      const team = this.require(current);
      if (team.usedBytes + bytes > team.quotaBytes) throw new Error(`Storage quota exceeded for team ${current}`);
    }
    for (let current: string | undefined = teamId; current; current = this.teams.get(current)?.parentId) this.require(current).usedBytes += bytes;
  }
  effectiveQuota(teamId: string): number {
    let quota = this.require(teamId).quotaBytes;
    let parent = this.require(teamId).parentId;
    while (parent) { const team = this.require(parent); quota = Math.min(quota, team.quotaBytes - team.usedBytes); parent = team.parentId; }
    return Math.max(0, quota);
  }
  byDomain(domain: string): Team | undefined { const id = this.domains.get(normaliseDomain(domain)); return id ? structuredClone(this.teams.get(id)) : undefined; }
  tree(teamId: string): { team: Team; children: ReturnType<TeamService["tree"]>[] } { return { team: structuredClone(this.require(teamId)), children: [...this.teams.values()].filter((team) => team.parentId === teamId).map((team) => this.tree(team.id)) }; }
  private require(id: string): Team { const team = this.teams.get(id); if (!team) throw new Error("Team not found"); return team; }
}
function normaliseDomain(domain: string): string { const normalised = domain.trim().toLowerCase().replace(/\.$/, ""); if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalised)) throw new Error("Invalid custom domain"); return normalised; }
