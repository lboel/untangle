#!/usr/bin/env node
/**
 * `prepack` guard — WP-220.
 *
 * Der Befund, gegen den dieses Skript steht: `npm pack` / `npm publish`
 * schreiben `"workspace:*"` WOERTLICH in das gepackte Manifest. Ein Nutzer,
 * der so ein Tarball installiert, bekommt:
 *
 *   npm error code EUNSUPPORTEDPROTOCOL
 *   npm error Unsupported URL Type "workspace:": workspace:*
 *
 * `pnpm pack` / `pnpm publish` ersetzen das Protokoll beim Packen durch die
 * konkrete Version (`"@untangle-code/domain": "0.1.0"`). Der
 * Veroeffentlichungsweg MUSS also ueber pnpm laufen.
 *
 * Eine Fussnote in der README erzwingt das nicht — dieser Guard schon: npm
 * und pnpm fuehren beide `prepack` VOR dem Packen aus, also bricht der Lauf
 * hier ab, bevor ein kaputtes Tarball entsteht.
 *
 * Erkennung: `npm_config_user_agent` traegt den packenden Client
 * ("pnpm/10.34.5 npm/? node/v26.7.0 darwin arm64"). Faellt die Variable ganz
 * aus, wird ABGEBROCHEN statt durchgewunken — ein Guard, der im Zweifel
 * durchlaesst, ist keiner (BUILD_PLAN E4).
 *
 * Exit-Codes:
 *   0  Der packende Client ist pnpm.
 *   1  Alles andere. Die Meldung nennt genau einen naechsten Schritt.
 */

const userAgent = process.env["npm_config_user_agent"] ?? "";
const packageName = process.env["npm_package_name"] ?? "this package";

/** "pnpm/10.34.5 npm/? node/v26.7.0 ..." -> "pnpm/10.34.5" */
const clientToken = userAgent.split(" ")[0] ?? "";
const clientName = clientToken.split("/")[0] ?? "";

if (clientName === "pnpm") {
  process.exit(0);
}

const observed = userAgent === "" ? "(npm_config_user_agent is not set)" : userAgent;

process.stderr.write(
  `prepack-guard: ${packageName} cannot be packed with "${clientName === "" ? "?" : clientName}".
` +
    `\n` +
    `  Beobachtet : ${observed}\n` +
    `  Expected   : a client whose npm_config_user_agent starts with "pnpm/"
` +
    `\n` +
    `Reason: this package depends on other workspace packages through "workspace:*".
` +
    `npm leaves that protocol unchanged when packing, so installing the
` +
    `tarball fails with EUNSUPPORTEDPROTOCOL. pnpm replaces it during
` +
    `packing with concrete versions.
` +
    `\n` +
    `Next step: run the same command with pnpm, for example
` +
    `  pnpm pack        (instead of npm pack)
` +
    `  pnpm publish -r  (instead of npm publish)
`,
);
process.exit(1);
