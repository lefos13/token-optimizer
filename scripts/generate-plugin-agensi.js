const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* Agensi marketplace flow.
   Agensi (https://www.agensi.io) distributes SKILL.md skills as zip uploads
   and scans them for dangerous commands, network access, and env-var access.
   The MCP server itself is therefore NOT bundled: the listed skill only
   teaches the agent how to use the tools and points the user at the npm
   installer when the server is missing.

   Agensi packages are a single skill: a root SKILL.md that routes to
   supporting files (progressive disclosure). Extra skills such as setup are
   therefore shipped as reference playbooks, not as separate skills.

   Output layout (folder name must equal the SKILL.md `name`):
     plugin/agensi/token-optimizer/SKILL.md              (from skill/marketplace/SKILL.md)
     plugin/agensi/token-optimizer/references/setup.md   (from skill/setup/SKILL.md, frontmatter stripped)
     plugin/agensi/token-optimizer.zip                   (upload this; needs the `zip` CLI)
   This output is gitignored — upload it by hand from the Agensi creator
   dashboard. Do not edit generated files; run `npm run build:plugin:agensi`. */

const { EXTRA_SKILLS, readSkillParts } = require("./skill-sources");

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "agensi");
const skillName = "token-optimizer";
const skillDir = path.join(pluginDir, skillName);
const sourcePath = path.join(rootDir, "skill", "marketplace", "SKILL.md");

/* Extra skill name -> reference file the root SKILL.md links to. */
const REFERENCE_FILES = { "token-optimizer-setup": "setup.md" };

const VERSION = "3.1.0";

console.log("Generating Agensi skill package...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });

  const source = fs.readFileSync(sourcePath, "utf8");
  const nameMatch = source.match(/^---\r?\n[\s\S]*?^name:\s*(\S+)\s*$/m);
  if (!nameMatch || nameMatch[1] !== skillName) {
    console.error(`Error: ${sourcePath} frontmatter name must be "${skillName}".`);
    process.exit(1);
  }
  const stamped = source.replace(/^(# .+)$/m, `$1\n\n<!-- ${skillName} skill v${VERSION} -->`);
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), stamped);

  for (const skill of EXTRA_SKILLS) {
    const file = REFERENCE_FILES[skill.name];
    if (!file) {
      console.error(`Error: no Agensi reference file mapped for extra skill "${skill.name}".`);
      process.exit(1);
    }
    if (!source.includes(`references/${file}`)) {
      console.error(`Error: ${sourcePath} must route to references/${file}.`);
      process.exit(1);
    }
    fs.writeFileSync(path.join(skillDir, "references", file), readSkillParts(skill.source).body);
  }

  const zip = spawnSync("zip", ["-qr", `${skillName}.zip`, skillName], { cwd: pluginDir, encoding: "utf8" });
  if (zip.error || zip.status !== 0) {
    console.warn(`Warning: could not create ${skillName}.zip (${zip.error ? zip.error.message : zip.stderr.trim()}). Zip plugin/agensi/${skillName}/ manually.`);
  }

  console.log(`Agensi skill v${VERSION} generated in ${pluginDir}`);
} catch (error) {
  console.error("Failed to generate Agensi skill package:", error);
  process.exit(1);
}
