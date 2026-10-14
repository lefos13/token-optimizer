const fs = require("fs");
const path = require("path");

/* Skills shipped alongside the main token-optimizer skill. Every generator
   copies these into its skills/ container (Cursor renders them as rules), so
   adding a skill here ships it to every client. */
const rootDir = path.resolve(__dirname, "..");

const EXTRA_SKILLS = [
  { name: "token-optimizer-setup", source: path.join(rootDir, "skill", "setup", "SKILL.md") },
];

function copyExtraSkills(skillsRoot) {
  for (const skill of EXTRA_SKILLS) {
    if (!fs.existsSync(skill.source)) {
      console.error(`Error: Source skill file not found at ${skill.source}`);
      process.exit(1);
    }
    const dest = path.join(skillsRoot, skill.name);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(skill.source, path.join(dest, "SKILL.md"));
  }
}

/* Splits SKILL.md into its description and markdown body so Cursor can
   render the skill as an agent-requested .mdc rule. */
function readSkillParts(source) {
  const text = fs.readFileSync(source, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing frontmatter in ${source}`);
  const description = (match[1].match(/^description:\s*(.+)$/m) || [])[1];
  if (!description) throw new Error(`Missing description in ${source}`);
  return { description: description.trim(), body: match[2].replace(/^\s+/, "") };
}

module.exports = { EXTRA_SKILLS, copyExtraSkills, readSkillParts };
