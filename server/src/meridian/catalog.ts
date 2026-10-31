/**
 * The Meridian Live catalogue: the ten coworker Bots brain.md §6 names, and the skills that give them
 * tools. A skill is an instruction plus the tools it needs; a Bot holds skills, and a live turn is
 * offered exactly the union of its skills' tools, nothing more.
 */

export type MeridianSkill = {
  slug: string;
  title: string;
  summary: string;
  instructions: string;
  tools: string[];
};

export type MeridianBot = {
  id: string;
  name: string;
  title: string;
  role: string;
  skills: string[];
};

export const MERIDIAN_SKILLS: readonly MeridianSkill[] = [
  {
    slug: "github-repo-management",
    title: "GitHub repository management",
    summary: "Inspect repositories, branches, issues and pull requests.",
    instructions:
      "Look the repository up before describing it. Quote issue and pull request numbers you read; never invent one.",
    tools: [
      "github_repo",
      "github_search_issues",
      "github_list_pulls",
      "github_list_branches",
    ],
  },
  {
    slug: "slack-sync",
    title: "Slack team sync",
    summary: "Post notifications and operational alerts to the team channel.",
    instructions:
      "Draft the message in the reply first. Posting needs the person's approval, which the tool asks for.",
    tools: ["slack_post"],
  },
  {
    slug: "database-auditing",
    title: "Database auditing",
    summary: "Read-only schema, index and migration checks on the workspace database.",
    instructions:
      "Queries run in a read-only transaction. Prefer catalog views (information_schema, pg_indexes, pg_stat_user_tables). Show the query you ran.",
    tools: ["db_list_tables", "db_query"],
  },
  {
    slug: "web-automation",
    title: "Web automation",
    summary: "Search the public web and read pages.",
    instructions:
      "Search, then fetch the page you cite rather than answering from a snippet. Give the URL.",
    tools: ["web_search", "web_fetch"],
  },
  {
    slug: "infra-checks",
    title: "Infrastructure checks",
    summary: "Probe TCP ports and HTTP health endpoints.",
    instructions:
      "Report what the probe returned, including latency, and say plainly when something is unreachable.",
    tools: ["port_check", "http_health"],
  },
  {
    slug: "workspace-memory",
    title: "Workspace memory",
    summary: "Remember and recall facts across live sessions.",
    instructions:
      "Save a fact only when the person asks you to remember it or it is clearly durable. Recall before saying you do not know.",
    tools: ["memory_save", "memory_recall"],
  },
  {
    slug: "quant",
    title: "Quantitative work",
    summary: "Exact arithmetic and the current time.",
    instructions: "Use the calculator for any arithmetic beyond a single step.",
    tools: ["calculator", "current_time"],
  },
];

const ALL_DAY = ["workspace-memory", "quant"];

export const MERIDIAN_BOTS: readonly MeridianBot[] = [
  {
    id: "lead-architect",
    name: "Lead Architect",
    title: "System design",
    role: "System design, RFC reviews, and structural database planning.",
    skills: ["github-repo-management", "database-auditing", "web-automation", ...ALL_DAY],
  },
  {
    id: "sec-auditor",
    name: "Security Auditor",
    title: "Zero-trust security",
    role: "Zero-trust security audits, CVE tracking, and secret exposure scans.",
    skills: ["web-automation", "github-repo-management", "infra-checks", ...ALL_DAY],
  },
  {
    id: "data-engineer",
    name: "Data Engineer",
    title: "Postgres and pipelines",
    role: "Neon PostgreSQL query planning, indexing, and migration pipelines.",
    skills: ["database-auditing", ...ALL_DAY],
  },
  {
    id: "compliance-officer",
    name: "Compliance Officer",
    title: "Audit and PII",
    role: "PII leak verification, SOC2 checklists, and audit trail validation.",
    skills: ["database-auditing", "web-automation", ...ALL_DAY],
  },
  {
    id: "devops-sre",
    name: "DevOps SRE",
    title: "Reliability",
    role: "Infrastructure monitoring, port hygiene, and container reliability.",
    skills: ["infra-checks", "slack-sync", "github-repo-management", ...ALL_DAY],
  },
  {
    id: "frontend-specialist",
    name: "Frontend Specialist",
    title: "React and UI",
    role: "React, Tailwind, and TanStack Router UI optimization.",
    skills: ["web-automation", "github-repo-management", ...ALL_DAY],
  },
  {
    id: "qa-automator",
    name: "QA Automator",
    title: "Verification",
    role: "Playwright test suites, regression scans, and end-to-end verification.",
    skills: ["web-automation", "infra-checks", "github-repo-management", ...ALL_DAY],
  },
  {
    id: "finance-analyst",
    name: "Finance Analyst",
    title: "Modeling",
    role: "Financial statement modeling and quantitative reporting.",
    skills: ["web-automation", "database-auditing", ...ALL_DAY],
  },
  {
    id: "triage-bot",
    name: "Triage Bot",
    title: "Issues and PRs",
    role: "GitHub issue routing, automated labeling, and pull request reviews.",
    skills: ["github-repo-management", "slack-sync", ...ALL_DAY],
  },
  {
    id: "onboarding-guide",
    name: "Onboarding Guide",
    title: "Getting started",
    role: "Workspace configuration, environment setup, and tool onboarding.",
    skills: ["web-automation", "infra-checks", ...ALL_DAY],
  },
];

export function findBot(id: string | undefined): MeridianBot {
  return MERIDIAN_BOTS.find((bot) => bot.id === id) ?? MERIDIAN_BOTS[0]!;
}

export function skillsFor(bot: MeridianBot): MeridianSkill[] {
  return bot.skills
    .map((slug) => MERIDIAN_SKILLS.find((skill) => skill.slug === slug))
    .filter((skill): skill is MeridianSkill => Boolean(skill));
}

export function toolNamesFor(bot: MeridianBot): string[] {
  return [...new Set(skillsFor(bot).flatMap((skill) => skill.tools))];
}
