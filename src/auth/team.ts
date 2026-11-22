export interface TeamBranding {
  name: string;
  color: string;
  logoUrl?: string;
}
export interface Team {
  id: string;
  name: string;
  parentId?: string;
  domain?: string;
  quotaBytes: number;
  usedBytes: number;
  branding: TeamBranding;
}
export interface BrandingOverride {
  name?: string | null;
  color?: string | null;
  logoUrl?: string | null;
}
export type CreateTeamInput = Omit<Team, "usedBytes" | "branding"> & { branding?: BrandingOverride };
export interface UpdateTeamInput {
  name?: string;
  parentId?: string | null;
  domain?: string | null;
  quotaBytes?: number;
  branding?: BrandingOverride;
}
export interface TeamMember {
  teamId: string;
  userId: string;
  roles: string[];
}
export interface TeamTree {
  team: Team;
  children: TeamTree[];
}

interface StoredBranding {
  name?: string;
  color?: string;
  logoUrl?: string | null;
}
type StoredTeam = Omit<Team, "branding"> & { branding: StoredBranding };

export class TeamService {
  private teams = new Map<string, StoredTeam>();
  private domains = new Map<string, string>();
  private readonly members = new Map<string, TeamMember[]>();

  create(input: CreateTeamInput): Team {
    if (typeof input !== "object" || input === null) throw new Error("Invalid team");
    const id = teamId(input.id);
    if (this.teams.has(id)) throw new Error("Team already exists");
    const name = teamName(input.name);
    const quotaBytes = input.quotaBytes;
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) throw new Error("Invalid team quota");
    const parentId = input.parentId === undefined ? undefined : teamId(input.parentId);
    if (parentId !== undefined) {
      if (!this.teams.has(parentId)) throw new Error("Parent team does not exist");
      if (this.effectiveQuota(parentId) < quotaBytes) throw new Error("Child quota exceeds inherited quota");
    }
    let domain: string | undefined;
    if (input.domain !== undefined) {
      domain = normaliseDomain(input.domain);
      if (this.domains.has(domain)) throw new Error("Domain is already bound");
    }
    const branding = brandingOverrides(input.branding);
    const team: StoredTeam = {
      id,
      name,
      ...(parentId === undefined ? {} : { parentId }),
      ...(domain === undefined ? {} : { domain }),
      quotaBytes,
      usedBytes: 0,
      branding,
    };
    const nextTeams = structuredClone(this.teams);
    nextTeams.set(id, team);
    validateTeams(nextTeams);
    const nextDomains = new Map(this.domains);
    if (domain !== undefined) nextDomains.set(domain, id);
    this.teams = nextTeams;
    this.domains = nextDomains;
    return this.publicTeam(this.require(id));
  }

  get(id: string): Team | undefined {
    const team = this.teams.get(id);
    return team ? this.publicTeam(team) : undefined;
  }

  list(parentId?: string): Team[] {
    return [...this.teams.values()]
      .filter((team) => parentId === undefined || team.parentId === parentId)
      .map((team) => this.publicTeam(team));
  }

  update(id: string, input: UpdateTeamInput): Team {
    const current = this.require(id);
    if (typeof input !== "object" || input === null) throw new Error("Invalid team update");
    const nextTeams = structuredClone(this.teams);
    const team = nextTeams.get(id);
    if (!team) throw new Error("Team not found");
    let parentChanged = false;
    let parentId = current.parentId;
    if (Object.hasOwn(input, "parentId")) {
      parentId = input.parentId === null || input.parentId === undefined ? undefined : teamId(input.parentId);
      if (parentId !== undefined && !this.teams.has(parentId)) throw new Error("Parent team does not exist");
      assertNoCycle(id, parentId, this.teams);
      parentChanged = parentId !== current.parentId;
    }
    if (Object.hasOwn(input, "name")) team.name = teamName(input.name);
    if (Object.hasOwn(input, "quotaBytes")) {
      const quotaBytes = input.quotaBytes;
      if (
        typeof quotaBytes !== "number" ||
        !Number.isSafeInteger(quotaBytes) ||
        quotaBytes < 0 ||
        quotaBytes < current.usedBytes
      )
        throw new Error("Invalid team quota");
      team.quotaBytes = quotaBytes;
    }
    let domainChanged = false;
    let nextDomain = current.domain;
    if (Object.hasOwn(input, "domain")) {
      nextDomain =
        input.domain === null || input.domain === undefined ? undefined : normaliseDomain(input.domain);
      if (nextDomain !== undefined) {
        const bound = this.domains.get(nextDomain);
        if (bound !== undefined && bound !== id) throw new Error("Domain is already bound");
      }
      domainChanged = nextDomain !== current.domain;
    }
    if (Object.hasOwn(input, "branding")) team.branding = mergeBranding(team.branding, input.branding);
    if (domainChanged) {
      if (nextDomain === undefined) delete team.domain;
      else team.domain = nextDomain;
    }
    if (parentChanged) changeParent(nextTeams, this.teams, id, parentId);
    validateTeams(nextTeams);
    const nextDomains = new Map(this.domains);
    if (domainChanged) {
      if (current.domain !== undefined) nextDomains.delete(current.domain);
      if (nextDomain !== undefined) nextDomains.set(nextDomain, id);
    }
    this.teams = nextTeams;
    this.domains = nextDomains;
    return this.publicTeam(this.require(id));
  }

  move(teamIdValue: string, parentId?: string): void {
    this.update(teamIdValue, { parentId: parentId ?? null });
  }

  addMember(member: TeamMember): void {
    if (!isRecord(member)) throw new Error("Invalid team member");
    const teamIdValue = teamId(member.teamId);
    this.require(teamIdValue);
    const userId = memberId(member.userId);
    if (!Array.isArray(member.roles)) throw new Error("Invalid member roles");
    const roles: string[] = [];
    for (const role of member.roles) {
      const validated = roleName(role);
      if (!roles.includes(validated)) roles.push(validated);
    }
    const list = (this.members.get(teamIdValue) ?? []).map((item) => ({ ...item, roles: [...item.roles] }));
    const existing = list.find((item) => item.userId === userId);
    if (existing) existing.roles = roles;
    else list.push({ teamId: teamIdValue, userId, roles });
    this.members.set(teamIdValue, list);
  }

  membersOf(teamIdValue: string): TeamMember[] {
    return (this.members.get(teamIdValue) ?? []).map((member) => ({ ...member, roles: [...member.roles] }));
  }

  rolesFor(teamIdValue: string, userId: string): string[] {
    this.require(teamIdValue);
    const lineage = this.lineage(teamIdValue).reverse();
    const roles = new Set<string>();
    for (const team of lineage) {
      const member = this.members.get(team.id)?.find((item) => item.userId === userId);
      for (const role of member?.roles ?? []) roles.add(role);
    }
    return [...roles];
  }

  effectiveRoles(teamIdValue: string, userId: string): string[] {
    return this.rolesFor(teamIdValue, userId);
  }

  consumeQuota(teamIdValue: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage delta");
    const lineage = this.lineage(teamIdValue);
    for (const team of lineage) {
      if (!Number.isSafeInteger(team.usedBytes + bytes) || team.usedBytes + bytes > team.quotaBytes)
        throw new Error(`Storage quota exceeded for team ${team.id}`);
    }
    const nextTeams = structuredClone(this.teams);
    for (const team of lineage) {
      const target = nextTeams.get(team.id);
      if (!target) throw new Error("Team not found");
      target.usedBytes += bytes;
    }
    this.teams = nextTeams;
  }

  releaseQuota(teamIdValue: string, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid storage delta");
    const lineage = this.lineage(teamIdValue);
    const usedBytes = lineage[0]?.usedBytes;
    if (usedBytes === undefined || bytes > usedBytes) throw new Error("Invalid storage delta");
    for (const team of lineage) if (team.usedBytes < bytes) throw new Error("Invalid storage delta");
    const nextTeams = structuredClone(this.teams);
    for (const team of lineage) {
      const target = nextTeams.get(team.id);
      if (!target) throw new Error("Team not found");
      target.usedBytes -= bytes;
    }
    this.teams = nextTeams;
  }

  effectiveQuota(teamIdValue: string): number {
    let quota = Number.POSITIVE_INFINITY;
    for (const team of this.lineage(teamIdValue)) quota = Math.min(quota, team.quotaBytes - team.usedBytes);
    return Math.max(0, quota);
  }

  effectiveBranding(teamIdValue: string): TeamBranding {
    const team = this.require(teamIdValue);
    return effectiveBranding(team, this.teams);
  }

  byDomain(domain: string): Team | undefined {
    const normalised =
      typeof domain === "string" && domain.includes(":") ? domainFromHost(domain) : normaliseDomain(domain);
    const id = this.domains.get(normalised);
    const team = id === undefined ? undefined : this.teams.get(id);
    return team ? this.publicTeam(team) : undefined;
  }

  byHost(host: string): Team | undefined {
    const id = this.domains.get(domainFromHost(host));
    const team = id === undefined ? undefined : this.teams.get(id);
    return team ? this.publicTeam(team) : undefined;
  }

  tree(teamIdValue: string): TeamTree {
    const team = this.require(teamIdValue);
    return {
      team: this.publicTeam(team),
      children: [...this.teams.values()]
        .filter((candidate) => candidate.parentId === team.id)
        .map((candidate) => this.tree(candidate.id)),
    };
  }

  private require(id: string): StoredTeam {
    const team = this.teams.get(id);
    if (!team) throw new Error("Team not found");
    return team;
  }

  private lineage(id: string): StoredTeam[] {
    this.require(id);
    const result: StoredTeam[] = [];
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined) {
      if (visited.has(current)) throw new Error("Team hierarchy cycle detected");
      visited.add(current);
      const team = this.require(current);
      result.push(team);
      current = team.parentId;
    }
    return result;
  }

  private publicTeam(team: StoredTeam): Team {
    return {
      id: team.id,
      name: team.name,
      ...(team.parentId === undefined ? {} : { parentId: team.parentId }),
      ...(team.domain === undefined ? {} : { domain: team.domain }),
      quotaBytes: team.quotaBytes,
      usedBytes: team.usedBytes,
      branding: effectiveBranding(team, this.teams),
    };
  }
}

function changeParent(
  next: Map<string, StoredTeam>,
  original: Map<string, StoredTeam>,
  id: string,
  parentId: string | undefined,
): void {
  const moving = next.get(id);
  const existing = original.get(id);
  if (!moving || !existing) throw new Error("Team not found");
  assertNoCycle(id, parentId, original);
  const oldAncestors = ancestorIds(existing, original);
  const newAncestors = parentId === undefined ? [] : ancestorIds(original.get(parentId), original, true);
  const oldSet = new Set(oldAncestors);
  let available = Number.POSITIVE_INFINITY;
  for (const ancestorId of newAncestors) {
    const ancestor = original.get(ancestorId);
    if (!ancestor) throw new Error("Parent team does not exist");
    const baseUsed = ancestor.usedBytes - (oldSet.has(ancestorId) ? existing.usedBytes : 0);
    available = Math.min(available, ancestor.quotaBytes - baseUsed);
  }
  if (available < moving.quotaBytes) throw new Error("Child quota exceeds inherited quota");
  const affected = new Set([...oldAncestors, ...newAncestors]);
  for (const ancestorId of affected) {
    const ancestor = next.get(ancestorId);
    if (!ancestor) throw new Error("Team not found");
    const delta =
      (newAncestors.includes(ancestorId) ? existing.usedBytes : 0) -
      (oldSet.has(ancestorId) ? existing.usedBytes : 0);
    const usedBytes = ancestor.usedBytes + delta;
    if (!Number.isSafeInteger(usedBytes) || usedBytes < 0 || usedBytes > ancestor.quotaBytes)
      throw new Error(`Storage quota exceeded for team ${ancestorId}`);
    ancestor.usedBytes = usedBytes;
  }
  if (parentId === undefined) delete moving.parentId;
  else moving.parentId = parentId;
}

function assertNoCycle(id: string, parentId: string | undefined, teams: Map<string, StoredTeam>): void {
  const visited = new Set<string>();
  let current = parentId;
  while (current !== undefined) {
    if (current === id || visited.has(current)) throw new Error("Team hierarchy cycle detected");
    visited.add(current);
    const parent = teams.get(current);
    if (!parent) throw new Error("Parent team does not exist");
    current = parent.parentId;
  }
}

function ancestorIds(
  team: StoredTeam | undefined,
  teams: Map<string, StoredTeam>,
  includeTeam = false,
): string[] {
  if (!team) throw new Error("Parent team does not exist");
  const result = includeTeam ? [team.id] : [];
  const visited = new Set(result);
  let current = team.parentId;
  while (current !== undefined) {
    if (visited.has(current)) throw new Error("Team hierarchy cycle detected");
    visited.add(current);
    const ancestor = teams.get(current);
    if (!ancestor) throw new Error("Parent team does not exist");
    result.push(current);
    current = ancestor.parentId;
  }
  return result;
}

function validateTeams(teams: Map<string, StoredTeam>): void {
  for (const team of teams.values()) {
    if (
      !Number.isSafeInteger(team.quotaBytes) ||
      !Number.isSafeInteger(team.usedBytes) ||
      team.quotaBytes < 0 ||
      team.usedBytes < 0 ||
      team.usedBytes > team.quotaBytes
    )
      throw new Error("Invalid team quota");
    assertNoCycle(team.id, team.parentId, teams);
  }
  for (const team of teams.values()) {
    if (team.parentId === undefined) continue;
    let available = Number.POSITIVE_INFINITY;
    for (const ancestorId of ancestorIds(team, teams)) {
      const ancestor = teams.get(ancestorId);
      if (!ancestor) throw new Error("Parent team does not exist");
      available = Math.min(available, ancestor.quotaBytes - ancestor.usedBytes + team.usedBytes);
    }
    if (available < team.quotaBytes) throw new Error("Child quota exceeds inherited quota");
  }
  for (const team of teams.values()) effectiveBranding(team, teams);
}

function effectiveBranding(team: StoredTeam, teams: Map<string, StoredTeam>): TeamBranding {
  const lineage: StoredTeam[] = [];
  const visited = new Set<string>();
  let current: StoredTeam | undefined = team;
  while (current) {
    if (visited.has(current.id)) throw new Error("Team hierarchy cycle detected");
    visited.add(current.id);
    lineage.push(current);
    current = current.parentId === undefined ? undefined : teams.get(current.parentId);
  }
  const result: { name?: string; color?: string; logoUrl?: string } = {};
  for (const item of lineage.reverse()) {
    if (item.branding.name !== undefined) result.name = item.branding.name;
    if (item.branding.color !== undefined) result.color = item.branding.color;
    if (item.branding.logoUrl === null) delete result.logoUrl;
    else if (item.branding.logoUrl !== undefined) result.logoUrl = item.branding.logoUrl;
  }
  if (result.name === undefined || result.color === undefined)
    throw new Error("Invalid branding: root name and color are required");
  return {
    name: result.name,
    color: result.color,
    ...(result.logoUrl === undefined ? {} : { logoUrl: result.logoUrl }),
  };
}

function brandingOverrides(input: BrandingOverride | undefined): StoredBranding {
  if (input === undefined) return {};
  if (typeof input !== "object" || input === null) throw new Error("Invalid branding");
  return mergeBranding({}, input);
}

function mergeBranding(current: StoredBranding, input: BrandingOverride | undefined): StoredBranding {
  if (typeof input !== "object" || input === null) throw new Error("Invalid branding");
  const result = { ...current };
  if (Object.hasOwn(input, "name")) {
    if (input.name === null || input.name === undefined) delete result.name;
    else result.name = brandingName(input.name);
  }
  if (Object.hasOwn(input, "color")) {
    if (input.color === null || input.color === undefined) delete result.color;
    else result.color = brandingColor(input.color);
  }
  if (Object.hasOwn(input, "logoUrl")) {
    if (input.logoUrl === null || input.logoUrl === undefined) result.logoUrl = null;
    else result.logoUrl = brandingUrl(input.logoUrl);
  }
  return result;
}

function normaliseDomain(domain: string): string {
  if (typeof domain !== "string") throw new Error("Invalid custom domain");
  const normalised = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalised))
    throw new Error("Invalid custom domain");
  return normalised;
}

function domainFromHost(host: string): string {
  if (typeof host !== "string") throw new Error("Invalid Host header");
  const value = host.trim();
  if (!value || /[\s\\/@?#]/.test(value) || value.startsWith("[")) throw new Error("Invalid Host header");
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  let domain = value;
  if (lastColon >= 0) {
    if (firstColon !== lastColon) throw new Error("Invalid Host header");
    domain = value.slice(0, lastColon);
    const port = value.slice(lastColon + 1);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
      throw new Error("Invalid Host header");
  }
  if (!domain) throw new Error("Invalid Host header");
  return normaliseDomain(domain);
}

function teamId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error("Invalid team id");
  return value;
}

function teamName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid team name");
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Invalid team name");
  return name;
}

function memberId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid member user id");
  return value.trim();
}

function roleName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid member roles");
  return value.trim();
}

function brandingName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid branding name");
  const name = value.trim();
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error("Invalid branding name");
  return name;
}

function brandingColor(value: unknown): string {
  if (typeof value !== "string" || !/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value))
    throw new Error("Invalid branding color");
  return value;
}

function brandingUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error("Invalid branding URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid branding URL");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password)
    throw new Error("Invalid branding URL");
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
