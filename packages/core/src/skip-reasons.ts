/**
 * Uebersetzung der Ausschlussgruende des Scanners in die geschlossene Menge
 * des Skip-Ledgers (`SkipReason`, domain `skip-ledger.ts`).
 *
 * Sie wirft nichts weg — sie benennt nur in der Sprache des Ledgers, was der
 * Scanner in seiner eigenen sagt. Der urspruengliche Grund bleibt im `detail`
 * des Eintrags woertlich stehen, damit die Uebersetzung nachpruefbar ist.
 */
import type { SkipReason } from "@untangle-code/domain";
import type { ExclusionReason } from "@untangle-code/scanner";

export function scannerSkipReason(reason: ExclusionReason): SkipReason {
  switch (reason) {
    case "binary":
      return "binary_content";
    case "size-limit":
      return "file_too_large";
    case "unreadable":
      return "provider_unavailable";
    case "security":
    case "config-exclude":
    case "untangleignore":
    case "gitignore":
    case "default-exclude":
    case "symlink-cycle":
    case "symlink-escape":
      return "excluded_by_configuration";
    default: {
      // Ein neuer Grund des Scanners darf nicht stillschweigend zu
      // "excluded_by_configuration" werden — der Compiler erzwingt hier eine
      // bewusste Zuordnung, sobald `ExclusionReason` waechst.
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
